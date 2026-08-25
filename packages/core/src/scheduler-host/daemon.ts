import {
  SCHEDULER_LIMITS,
  type ClaimedInvocation,
  type ExecutorIdentity,
  type ScheduleStore,
} from "@roll-agent/runtime";
import type { InvocationSpawner, SpawnedInvocation } from "./spawn-invocation.ts";

export type { SpawnedInvocation } from "./spawn-invocation.ts";

export interface SchedulerDaemonLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface SchedulerDaemonOptions {
  readonly store: ScheduleStore;
  readonly workerId: string;
  readonly maxConcurrentRuns: number;
  readonly spawnInvocation: InvocationSpawner;
  readonly logger: SchedulerDaemonLogger;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly maxTimerDelayMs?: number;
  readonly maxRunMs?: number;
  readonly childTerminateGraceMs?: number;
  readonly terminateExecutor?: (executor: ExecutorIdentity) => boolean;
}

interface RunningInvocation {
  readonly ownershipToken: string;
  readonly handle: SpawnedInvocation;
  readonly runTimer: ReturnType<typeof setTimeout>;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) {
    return Promise.resolve();
  }
  return Promise.race([
    Promise.allSettled(promises).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs).unref();
    }),
  ]);
}

export class SchedulerDaemon {
  private readonly store: ScheduleStore;
  private readonly workerId: string;
  private readonly maxConcurrentRuns: number;
  private readonly spawnInvocation: InvocationSpawner;
  private readonly logger: SchedulerDaemonLogger;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly maxTimerDelayMs: number;
  private readonly maxRunMs: number;
  private readonly childTerminateGraceMs: number;
  private readonly terminateExecutor: ((executor: ExecutorIdentity) => boolean) | undefined;
  private readonly running = new Map<string, RunningInvocation>();
  private wake = Promise.withResolvers<void>();
  private stopped = false;

  constructor(options: SchedulerDaemonOptions) {
    this.store = options.store;
    this.workerId = options.workerId;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.spawnInvocation = options.spawnInvocation;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? SCHEDULER_LIMITS.pollIntervalMs;
    this.leaseRenewIntervalMs =
      options.leaseRenewIntervalMs ?? SCHEDULER_LIMITS.leaseRenewIntervalMs;
    this.maxTimerDelayMs = options.maxTimerDelayMs ?? MAX_TIMER_DELAY_MS;
    this.maxRunMs = options.maxRunMs ?? SCHEDULER_LIMITS.maxRunMs;
    this.childTerminateGraceMs =
      options.childTerminateGraceMs ?? SCHEDULER_LIMITS.childTerminateGraceMs;
    this.terminateExecutor = options.terminateExecutor;
  }

  get runningCount(): number {
    return this.running.size;
  }

  tick(): number {
    try {
      const pruned = this.store.pruneInvocations(this.now());
      if (pruned > 0) {
        this.logger.info(`已清理 ${String(pruned)} 条过期运行记录`);
      }
    } catch (error) {
      this.logger.error(`清理运行记录失败：${errorMessage(error)}`);
    }
    this.renewLeases();
    this.boundOrphans();
    const capacity = this.maxConcurrentRuns - this.running.size;
    let claims: ClaimedInvocation[];
    try {
      claims = this.store.claimDue({
        workerId: this.workerId,
        nowMs: this.now(),
        limit: Math.max(capacity, 0),
        heldInvocationIds: new Set(this.running.keys()),
      });
    } catch (error) {
      this.logger.error(`claimDue 失败：${errorMessage(error)}`);
      return 0;
    }
    for (const claim of claims) {
      this.launch(claim);
    }
    return claims.length;
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return;
    }
    const onAbort = () => {
      this.stopped = true;
      this.wake.resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const renewTimer = setInterval(() => this.renewLeases(), this.leaseRenewIntervalMs);
    this.logger.info(`scheduler daemon 启动，workerId=${this.workerId}`);
    try {
      while (!this.stopped) {
        const launched = this.tick();
        await this.sleepUntilWake(launched > 0);
      }
    } finally {
      clearInterval(renewTimer);
      signal?.removeEventListener("abort", onAbort);
      await this.terminateChildren();
      this.logger.info("scheduler daemon 已停止");
    }
  }

  private launch(claim: ClaimedInvocation): void {
    const id = claim.invocation.id;
    if (this.running.has(id)) {
      this.logger.error(`invocation ${id} 仍在本 daemon 运行中，拒绝重复启动`);
      return;
    }
    this.logger.info(
      `触发 ${claim.schedule.name}（schedule=${claim.schedule.id} invocation=${id} attempt=${String(claim.invocation.attempt)}）`,
    );
    let handle: SpawnedInvocation;
    try {
      handle = this.spawnInvocation(claim);
    } catch (error) {
      const message = `无法启动 exec 子进程：${errorMessage(error)}`;
      this.logger.error(`invocation ${id} ${message}`);
      this.store.failInvocation(id, claim.ownershipToken, message, this.now());
      return;
    }
    const runTimer = setTimeout(
      () => {
        this.logger.error(
          `invocation ${id} 运行超过 ${String(this.maxRunMs)} ms，强制终止 exec 子进程`,
        );
        handle.kill("SIGKILL");
      },
      Math.min(this.maxRunMs, this.maxTimerDelayMs),
    );
    runTimer.unref();
    this.running.set(id, { ownershipToken: claim.ownershipToken, handle, runTimer });
    handle.exited
      .then((code) => {
        this.onExit(claim, code);
      })
      .catch((error: unknown) => {
        this.onExit(claim, null);
        this.logger.error(`invocation ${id} 退出监听异常：${errorMessage(error)}`);
      });
  }

  private onExit(claim: ClaimedInvocation, code: number | null): void {
    const id = claim.invocation.id;
    const entry = this.running.get(id);
    if (entry === undefined || entry.ownershipToken !== claim.ownershipToken) {
      return;
    }
    clearTimeout(entry.runTimer);
    this.running.delete(id);
    let outcome: ReturnType<ScheduleStore["failInvocation"]>;
    try {
      outcome = this.store.failInvocation(
        id,
        claim.ownershipToken,
        `exec 进程退出 code=${code === null ? "null" : String(code)}，未写入执行结果`,
        this.now(),
      );
    } catch (error) {
      this.logger.error(`invocation ${id} 退出后写账本失败：${errorMessage(error)}`);
      this.wake.resolve();
      return;
    }
    if (outcome !== "lost-claim") {
      this.logger.error(
        `invocation ${id} 未正常完成（code=${String(code)}），处理结果：${outcome}`,
      );
    } else if (code !== 0) {
      this.logger.error(`invocation ${id} 已写入结果但子进程 code=${String(code)}`);
    } else {
      this.logger.info(`invocation ${id} 完成`);
    }
    this.wake.resolve();
  }

  private renewLeases(): void {
    for (const [id, entry] of this.running) {
      if (!this.store.renewLease(id, entry.ownershipToken, this.now())) {
        this.logger.error(`invocation ${id} 的 lease 已丢失，子进程结果将被忽略`);
      }
    }
  }

  private boundOrphans(): void {
    if (this.terminateExecutor === undefined) {
      return;
    }
    const cutoff = this.now() - this.maxRunMs;
    let rows: ReturnType<ScheduleStore["listRunningInvocations"]>;
    try {
      rows = this.store.listRunningInvocations();
    } catch (error) {
      this.logger.error(`读取运行中记录失败：${errorMessage(error)}`);
      return;
    }
    for (const row of rows) {
      if (
        this.running.has(row.id) ||
        row.executor === undefined ||
        row.startedAtMs === undefined ||
        row.startedAtMs > cutoff
      ) {
        continue;
      }
      const killed = this.terminateExecutor(row.executor);
      this.logger.error(
        `invocation ${row.id} 的 exec 进程 (pid ${String(row.executor.pid)}) 不属于本 daemon 且运行超过 ${String(this.maxRunMs)} ms，${killed ? "已发送 SIGKILL" : "身份无法确认，未处理"}`,
      );
    }
  }

  private async sleepUntilWake(progressed: boolean): Promise<void> {
    const nowMs = this.now();
    const wakeAt = this.store.nextWakeAtMs();
    const target = Math.min(wakeAt ?? Number.POSITIVE_INFINITY, nowMs + this.pollIntervalMs);
    const rawDelay = target - nowMs;
    const delay =
      rawDelay <= 0 && !progressed
        ? this.pollIntervalMs
        : Math.min(Math.max(rawDelay, 0), this.maxTimerDelayMs);
    this.wake = Promise.withResolvers<void>();
    const timer = setTimeout(() => this.wake.resolve(), delay);
    try {
      await this.wake.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  private async terminateChildren(): Promise<void> {
    for (const [id, entry] of this.running) {
      const outcome = entry.handle.kill("SIGTERM");
      if (typeof outcome === "string" && outcome !== "tree-terminated") {
        this.logger.error(
          `invocation ${id} 的 exec 进程树未能整体终止（${outcome}），仅根进程收到信号`,
        );
      }
    }
    await settleWithin(
      [...this.running.values()].map((entry) => entry.handle.exited),
      this.childTerminateGraceMs,
    );
    if (this.running.size === 0) {
      return;
    }
    for (const [id, entry] of this.running) {
      this.logger.error(
        `invocation ${id} 的 exec 子进程在 ${String(this.childTerminateGraceMs)} ms 内未退出，发送 SIGKILL`,
      );
      entry.handle.kill("SIGKILL");
    }
    await settleWithin(
      [...this.running.values()].map((entry) => entry.handle.exited),
      this.childTerminateGraceMs,
    );
    for (const [id, entry] of this.running) {
      clearTimeout(entry.runTimer);
      this.running.delete(id);
      this.logger.error(
        `invocation ${id} 的 exec 子进程退出未确认，lease 到期后由探活决定是否重跑`,
      );
    }
  }
}
