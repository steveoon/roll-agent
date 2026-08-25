import { SCHEDULER_LIMITS, type ClaimedInvocation, type ScheduleStore } from "@roll-agent/runtime";
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
}

interface RunningInvocation {
  readonly ownershipToken: string;
  readonly handle: SpawnedInvocation;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  }

  get runningCount(): number {
    return this.running.size;
  }

  tick(): number {
    const capacity = this.maxConcurrentRuns - this.running.size;
    if (capacity <= 0) {
      return 0;
    }
    let claims: ClaimedInvocation[];
    try {
      claims = this.store.claimDue({ workerId: this.workerId, nowMs: this.now(), limit: capacity });
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
        this.tick();
        await this.sleepUntilWake();
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
    this.running.set(id, { ownershipToken: claim.ownershipToken, handle });
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
    this.running.delete(id);
    const outcome = this.store.failInvocation(
      id,
      claim.ownershipToken,
      `exec 进程退出 code=${code === null ? "null" : String(code)}，未写入执行结果`,
      this.now(),
    );
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

  private async sleepUntilWake(): Promise<void> {
    const nowMs = this.now();
    const wakeAt = this.store.nextWakeAtMs();
    const target = Math.min(wakeAt ?? Number.POSITIVE_INFINITY, nowMs + this.pollIntervalMs);
    const delay = Math.min(Math.max(target - nowMs, 0), this.maxTimerDelayMs);
    this.wake = Promise.withResolvers<void>();
    const timer = setTimeout(() => this.wake.resolve(), delay);
    try {
      await this.wake.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  private async terminateChildren(): Promise<void> {
    for (const entry of this.running.values()) {
      entry.handle.kill();
    }
    await Promise.allSettled([...this.running.values()].map((entry) => entry.handle.exited));
  }
}
