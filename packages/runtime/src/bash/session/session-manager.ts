import { performance } from "node:perf_hooks";
import type { BashStreamName } from "../exec.ts";
import type { ShellProfile } from "../profile.ts";
import { spawnSession } from "./session-exec.ts";
import {
  isTerminalSessionState,
  SESSION_STATES,
  SESSION_TERMINATION_CAUSES,
  type ManagedSession,
  type SessionSummary,
  type SessionTerminationCause,
  type TerminalSessionState,
} from "./types.ts";

const DEFAULT_INTERRUPT_GRACE_MS = 150;
const DEFAULT_KILL_TREE_TIMEOUT_MS = 2_500;
const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_ROOT_SETTLE_TIMEOUT_MS = 1_000;
const STREAM_DESTROY_SETTLE_MS = 50;
const COMMAND_PREVIEW_MAX_CHARS = 120;

export class SessionCapError extends Error {
  constructor(maxSessions: number) {
    super(`会话数已达上限 ${String(maxSessions)}，且无空闲会话可回收`);
    this.name = "SessionCapError";
  }
}

export interface SessionManagerOptions {
  readonly maxSessions: number;
  readonly profile: ShellProfile;
  readonly env: NodeJS.ProcessEnv;
  readonly bufferCapacity: number;
  readonly generateId?: () => number;
  readonly interruptGraceMs?: number;
  readonly killTreeTimeoutMs?: number;
  readonly closeDrainTimeoutMs?: number;
  readonly rootSettleTimeoutMs?: number;
}

export interface SpawnRequest {
  readonly command: string;
  readonly workdir: string;
  readonly onDelta?: (stream: BashStreamName, delta: string) => void;
}

export interface SessionCleanupResult {
  readonly sessionId: number;
  readonly state: TerminalSessionState;
  readonly cleanupError?: string;
}

type SessionTarget = number | Iterable<number>;

interface TerminationControl {
  intent: SessionTerminationCause;
  readonly errors: string[];
  promise: Promise<SessionCleanupResult>;
}

function defaultGenerateId(): number {
  return 1000 + Math.floor(Math.random() * 99_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandPreview(command: string): string {
  const singleLine = Array.from(command, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(singleLine);
  return characters.length <= COMMAND_PREVIEW_MAX_CHARS
    ? singleLine
    : `${characters.slice(0, COMMAND_PREVIEW_MAX_CHARS - 1).join("")}…`;
}

function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    promise.then(() => finish(true));
  });
}

export class SessionManager {
  private readonly sessions = new Map<number, ManagedSession>();
  private readonly terminations = new Map<number, TerminationControl>();
  private readonly options: SessionManagerOptions;
  private acceptingSessions = true;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  spawn(request: SpawnRequest): ManagedSession {
    if (!this.acceptingSessions) {
      throw new Error("会话管理器已关闭，不再接受新命令");
    }
    this.trimTombstones();
    if (this.size() >= this.options.maxSessions) {
      throw new SessionCapError(this.options.maxSessions);
    }
    const id = this.allocateId();
    const session = spawnSession({
      id,
      command: request.command,
      workdir: request.workdir,
      profile: this.options.profile,
      env: this.options.env,
      bufferCapacity: this.options.bufferCapacity,
      ...(request.onDelta ? { onDelta: request.onDelta } : {}),
    });
    this.sessions.set(id, session);
    this.observeLifecycle(session);
    return session;
  }

  get(id: number): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /** Explicitly forget a terminal result. Running sessions cannot be orphaned through this API. */
  delete(id: number): boolean {
    const session = this.sessions.get(id);
    if (session === undefined || !isTerminalSessionState(session.state)) {
      return false;
    }
    return this.sessions.delete(id);
  }

  /** Completed tombstones do not consume the cap; cleanup failures do until explicitly read/deleted. */
  size(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state !== SESSION_STATES.completed) {
        count += 1;
      }
    }
    return count;
  }

  list(): readonly SessionSummary[] {
    const now = performance.now();
    return [...this.sessions.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((session) => ({
        sessionId: session.id,
        commandPreview: commandPreview(session.command),
        workdir: session.workdir,
        state: session.state,
        startedAt: session.startedAt,
        lastUsedAt: session.lastUsedAt,
        wallTimeMs: (session.completedAt ?? now) - session.startedAt,
        ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
        ...(session.terminationCause ? { terminationCause: session.terminationCause } : {}),
        ...(session.cleanupError ? { cleanupError: session.cleanupError } : {}),
      }));
  }

  async interrupt(target: SessionTarget): Promise<readonly SessionCleanupResult[]> {
    return this.stopTargets(target, SESSION_TERMINATION_CAUSES.interrupt);
  }

  async terminate(target: SessionTarget): Promise<readonly SessionCleanupResult[]> {
    return this.stopTargets(target, SESSION_TERMINATION_CAUSES.terminate);
  }

  async interruptAll(): Promise<readonly SessionCleanupResult[]> {
    return this.stopTargets(this.activeIds(), SESSION_TERMINATION_CAUSES.interrupt);
  }

  async terminateAll(): Promise<readonly SessionCleanupResult[]> {
    return this.stopTargets(this.activeIds(), SESSION_TERMINATION_CAUSES.terminate);
  }

  async close(): Promise<readonly SessionCleanupResult[]> {
    this.acceptingSessions = false;
    return this.terminateAll();
  }

  private activeIds(): readonly number[] {
    return [...this.sessions.values()]
      .filter((session) => !isTerminalSessionState(session.state))
      .map((session) => session.id);
  }

  private async stopTargets(
    target: SessionTarget,
    intent: SessionTerminationCause,
  ): Promise<readonly SessionCleanupResult[]> {
    const ids = typeof target === "number" ? [target] : [...new Set(target)];
    const pending: Promise<SessionCleanupResult>[] = [];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session !== undefined && !isTerminalSessionState(session.state)) {
        pending.push(this.requestStop(session, intent));
      }
    }
    return Promise.all(pending);
  }

  private requestStop(
    session: ManagedSession,
    intent: SessionTerminationCause,
    initialError?: string,
  ): Promise<SessionCleanupResult> {
    const existing = this.terminations.get(session.id);
    if (existing !== undefined) {
      if (intent === SESSION_TERMINATION_CAUSES.terminate) {
        existing.intent = intent;
      }
      if (initialError !== undefined && !existing.errors.includes(initialError)) {
        existing.errors.push(initialError);
      }
      return existing.promise;
    }

    session.markStopping(intent);
    const control: TerminationControl = {
      intent,
      errors: initialError === undefined ? [] : [initialError],
      promise: Promise.resolve({
        sessionId: session.id,
        state: SESSION_STATES.cleanupFailed,
      }),
    };
    this.terminations.set(session.id, control);
    control.promise = this.runTermination(session, control).finally(() => {
      this.terminations.delete(session.id);
      this.trimTombstones();
    });
    return control.promise;
  }

  private async runTermination(
    session: ManagedSession,
    control: TerminationControl,
  ): Promise<SessionCleanupResult> {
    const firstIntent = control.intent;
    const firstKillError = await this.killTree(session, firstIntent);
    let treeKillFailed = firstKillError !== undefined;
    if (firstKillError !== undefined) {
      control.errors.push(firstKillError);
    }

    if (firstIntent === SESSION_TERMINATION_CAUSES.interrupt && !session.closeObserved) {
      if (control.intent !== SESSION_TERMINATION_CAUSES.terminate) {
        await waitForPromise(
          session.waitClose(),
          this.options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS,
        );
      }
      const rootExitMakesPidUnsafe =
        session.exitObserved && session.profile.waitForTreeKillAfterRootExit === true;
      if (!session.closeObserved && !rootExitMakesPidUnsafe) {
        const terminateError = await this.killTree(session, SESSION_TERMINATION_CAUSES.terminate);
        if (terminateError !== undefined) {
          treeKillFailed = true;
          control.errors.push(terminateError);
        }
      }
    }

    const rootSettleTimeoutMs = this.options.rootSettleTimeoutMs ?? DEFAULT_ROOT_SETTLE_TIMEOUT_MS;
    if (!session.exitObserved && !treeKillFailed) {
      await waitForPromise(session.waitExit(), rootSettleTimeoutMs);
    }
    if (!session.exitObserved) {
      const rootKillError = this.forceKillRoot(session);
      if (rootKillError !== undefined) {
        control.errors.push(rootKillError);
      }
      await waitForPromise(session.waitExit(), rootSettleTimeoutMs);
    }
    if (!session.exitObserved) {
      control.errors.push("根进程在强制终止请求后仍未确认退出");
    }

    if (!session.closeObserved) {
      await waitForPromise(
        session.waitClose(),
        this.options.closeDrainTimeoutMs ?? DEFAULT_CLOSE_DRAIN_TIMEOUT_MS,
      );
    }
    if (!session.closeObserved) {
      this.destroyStreams(session);
      await waitForPromise(session.waitClose(), STREAM_DESTROY_SETTLE_MS);
    }
    if (!session.closeObserved) {
      control.errors.push("进程树终止后仍未观察到根进程退出与 stdio close");
    }

    if (control.errors.length > 0) {
      session.markCleanupFailed(control.errors.join("；"));
    } else {
      session.markCompleted();
    }
    if (!isTerminalSessionState(session.state)) {
      session.markCleanupFailed("会话清理未能收口");
    }
    const finalState = session.state;
    if (!isTerminalSessionState(finalState)) {
      throw new Error(`会话 ${String(session.id)} 清理后仍处于非终态`);
    }

    return {
      sessionId: session.id,
      state: finalState,
      ...(session.cleanupError ? { cleanupError: session.cleanupError } : {}),
    };
  }

  private async killTree(
    session: ManagedSession,
    intent: SessionTerminationCause,
  ): Promise<string | undefined> {
    if (session.exitObserved && session.profile.waitForTreeKillAfterRootExit === true) {
      return "根进程已退出，不能安全复用旧 PID 清理或确认后代进程树";
    }
    const timeoutMs = this.options.killTreeTimeoutMs ?? DEFAULT_KILL_TREE_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const kill = session.profile.killTree(session.child.pid, intent, {
        signal: controller.signal,
      });
      await Promise.race([
        kill,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`进程树终止在 ${String(timeoutMs)}ms 内未完成`));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      controller.abort();
    }
  }

  private forceKillRoot(session: ManagedSession): string | undefined {
    if (session.exitObserved) {
      return undefined;
    }
    try {
      return session.child.kill("SIGKILL") ? undefined : "根进程强制终止请求未被接受";
    } catch (error) {
      return `根进程强制终止请求失败: ${errorMessage(error)}`;
    }
  }

  private destroyStreams(session: ManagedSession): void {
    session.child.stdin?.destroy();
    session.child.stdout?.destroy();
    session.child.stderr?.destroy();
    session.child.unref();
  }

  private observeLifecycle(session: ManagedSession): void {
    session.waitSettled().then(() => this.trimTombstones());
    session.waitExit().then(() => {
      if (session.closeObserved || isTerminalSessionState(session.state)) {
        return;
      }
      const timeoutMs = this.options.closeDrainTimeoutMs ?? DEFAULT_CLOSE_DRAIN_TIMEOUT_MS;
      waitForPromise(session.waitSettled(), timeoutMs).then((settled) => {
        if (settled || isTerminalSessionState(session.state)) {
          return;
        }
        this.requestStop(
          session,
          SESSION_TERMINATION_CAUSES.terminate,
          `根进程退出后 stdio 在 ${String(timeoutMs)}ms 内未关闭`,
        ).catch((error: unknown) => {
          session.markCleanupFailed(`会话自动清理失败：${errorMessage(error)}`);
        });
      });
    });
  }

  private trimTombstones(): void {
    const tombstones = [...this.sessions.values()]
      .filter(
        (session) =>
          session.state === SESSION_STATES.completed && !this.terminations.has(session.id),
      )
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    const excess = tombstones.length - this.options.maxSessions;
    for (let index = 0; index < excess; index += 1) {
      const session = tombstones[index];
      if (session !== undefined) {
        this.sessions.delete(session.id);
      }
    }
  }

  private allocateId(): number {
    const generate = this.options.generateId ?? defaultGenerateId;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const id = generate();
      if (!this.sessions.has(id)) {
        return id;
      }
    }
    throw new Error("无法分配唯一会话 id");
  }
}
