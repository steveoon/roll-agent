import type { BashStreamName } from "../exec.ts";
import type { ShellProfile } from "../profile.ts";
import { spawnSession } from "./session-exec.ts";
import type { ManagedSession } from "./types.ts";

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
}

export interface SpawnRequest {
  readonly command: string;
  readonly workdir: string;
  readonly onDelta?: (stream: BashStreamName, delta: string) => void;
}

function defaultGenerateId(): number {
  return 1000 + Math.floor(Math.random() * 99_000);
}

export class SessionManager {
  private readonly sessions = new Map<number, ManagedSession>();
  private readonly options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  spawn(request: SpawnRequest): ManagedSession {
    this.evictExited();
    if (this.sessions.size >= this.options.maxSessions) {
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
    return session;
  }

  get(id: number): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: number): void {
    this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }

  interruptAll(): void {
    for (const session of this.sessions.values()) {
      session.profile.killTree(session.child.pid, "interrupt").catch(() => {});
    }
    this.sessions.clear();
  }

  terminateAll(): void {
    for (const session of this.sessions.values()) {
      session.profile.killTree(session.child.pid, "terminate").catch(() => {});
    }
    this.sessions.clear();
  }

  private evictExited(): void {
    for (const [id, session] of this.sessions) {
      if (session.exitCode !== undefined) {
        this.sessions.delete(id);
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
