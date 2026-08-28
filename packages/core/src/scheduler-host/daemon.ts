import {
  EXECUTOR_LIVENESS,
  INVOCATION_FAILURE_OUTCOMES,
  SCHEDULER_LIMITS,
  type ClaimDueInput,
  type ClaimedInvocation,
  type ExecutorIdentity,
  type ExecutorLiveness,
  type ScheduleStore,
} from "@roll-agent/runtime";
import {
  KILL_PROCESS_TREE_OUTCOMES,
  terminateExecutorWithGrace,
  type KillProcessTreeOutcome,
} from "./executor-liveness.ts";
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
  readonly claimDue?: (input: ClaimDueInput) => ClaimedInvocation[] | undefined;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly maxTimerDelayMs?: number;
  readonly maxRunMs?: number;
  readonly childTerminateGraceMs?: number;
  readonly urgentStopSettleMs?: number;
  readonly terminateExecutor?: (
    executor: ExecutorIdentity,
    signal: NodeJS.Signals,
  ) => KillProcessTreeOutcome;
  readonly platform?: NodeJS.Platform;
}

interface RunningInvocation {
  readonly ownershipToken: string;
  readonly handle: SpawnedInvocation;
  readonly runTimer: ReturnType<typeof setTimeout>;
  forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  treeKillUnconfirmed: boolean;
  timeoutError: string | undefined;
  timedOutAtMs: number | undefined;
  rootExited: boolean;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const URGENT_STOP_SETTLE_MS = 2_000;

export const URGENT_STOP_REASON = "scheduler-daemon-urgent-stop" as const;

export function stopReasonFor(
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): typeof URGENT_STOP_REASON | undefined {
  return platform === "win32" && signal === "SIGHUP" ? URGENT_STOP_REASON : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class SchedulerDaemon {
  private readonly store: ScheduleStore;
  private readonly workerId: string;
  private readonly maxConcurrentRuns: number;
  private readonly spawnInvocation: InvocationSpawner;
  private readonly logger: SchedulerDaemonLogger;
  private readonly claimDue: (input: ClaimDueInput) => ClaimedInvocation[] | undefined;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly maxTimerDelayMs: number;
  private readonly maxRunMs: number;
  private readonly childTerminateGraceMs: number;
  private readonly urgentStopSettleMs: number;
  private readonly terminateExecutor:
    | ((executor: ExecutorIdentity, signal: NodeJS.Signals) => KillProcessTreeOutcome)
    | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly running = new Map<string, RunningInvocation>();
  private admissionRefused = false;
  private readonly terminatingOrphans = new Set<string>();
  private readonly scheduleCapLookupErrors = new Set<string>();
  private wake = Promise.withResolvers<void>();
  private stopped = false;
  private urgentStop = false;

  constructor(options: SchedulerDaemonOptions) {
    this.store = options.store;
    this.workerId = options.workerId;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.spawnInvocation = options.spawnInvocation;
    this.logger = options.logger;
    this.claimDue = options.claimDue ?? ((input) => this.store.claimDue(input));
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? SCHEDULER_LIMITS.pollIntervalMs;
    this.leaseRenewIntervalMs =
      options.leaseRenewIntervalMs ?? SCHEDULER_LIMITS.leaseRenewIntervalMs;
    this.maxTimerDelayMs = options.maxTimerDelayMs ?? MAX_TIMER_DELAY_MS;
    this.maxRunMs = options.maxRunMs ?? SCHEDULER_LIMITS.maxRunMs;
    this.childTerminateGraceMs =
      options.childTerminateGraceMs ?? SCHEDULER_LIMITS.childTerminateGraceMs;
    this.urgentStopSettleMs = options.urgentStopSettleMs ?? URGENT_STOP_SETTLE_MS;
    this.terminateExecutor = options.terminateExecutor;
    this.platform = options.platform ?? process.platform;
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
    let claimed: ClaimedInvocation[] | undefined;
    try {
      claimed = this.claimDue({
        workerId: this.workerId,
        nowMs: this.now(),
        limit: Math.max(capacity, 0),
        heldInvocationIds: new Set(this.running.keys()),
      });
    } catch (error) {
      this.logger.error(`claimDue 失败：${errorMessage(error)}`);
      return 0;
    }
    this.noteAdmission(claimed === undefined);
    const claims = claimed ?? [];
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
      this.urgentStop = signal?.reason === URGENT_STOP_REASON;
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
    const maxRunMs = claim.schedule.maxRunMs ?? this.maxRunMs;
    this.logger.info(
      `触发 ${claim.schedule.name}（schedule=${claim.schedule.id} invocation=${id} attempt=${String(claim.invocation.attempt)} max-run=${String(maxRunMs)} ms）`,
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
        const entry = this.running.get(id);
        if (entry === undefined) {
          return;
        }
        entry.timedOutAtMs = this.now();
        entry.timeoutError = `invocation ${id} 运行超过 ${String(maxRunMs)} ms`;
        if (this.platform === "win32") {
          this.logger.error(
            `invocation ${id} 运行超过 ${String(maxRunMs)} ms，强制终止 exec 子进程树`,
          );
          this.signalChild(id, "SIGKILL");
          return;
        }
        this.logger.error(
          `invocation ${id} 运行超过 ${String(maxRunMs)} ms，请求 exec 协作停止并清理工具进程`,
        );
        this.signalChild(id, "SIGTERM");
        entry.forceKillTimer = setTimeout(() => {
          entry.forceKillTimer = undefined;
          const current = this.running.get(id);
          if (current === entry && !entry.rootExited) {
            this.logger.error(
              `invocation ${id} 在 ${String(this.childTerminateGraceMs)} ms grace 内未退出，发送 SIGKILL`,
            );
            this.signalEntry(id, entry, "SIGKILL");
            return;
          }
          const liveness = this.executorLivenessAfterRootExit(id);
          if (liveness !== EXECUTOR_LIVENESS.descendants) {
            return;
          }
          this.logger.error(
            `invocation ${id} 的 exec root 已退出但后代仍存活，在 ${String(this.childTerminateGraceMs)} ms grace 后对捕获进程树发送 SIGKILL`,
          );
          this.signalEntry(id, entry, "SIGKILL");
          this.settleStoppedInvocation(
            id,
            entry,
            entry.timeoutError ?? "daemon max-run 已终止 exec 进程树",
          );
          this.wake.resolve();
        }, this.childTerminateGraceMs);
        entry.forceKillTimer.unref();
      },
      Math.min(maxRunMs, this.maxTimerDelayMs),
    );
    runTimer.unref();
    this.running.set(id, {
      ownershipToken: claim.ownershipToken,
      handle,
      runTimer,
      forceKillTimer: undefined,
      treeKillUnconfirmed: false,
      timeoutError: undefined,
      timedOutAtMs: undefined,
      rootExited: false,
    });
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
    entry.rootExited = true;
    let timeoutTreeUnsettled = false;
    if (entry.timeoutError !== undefined && entry.timedOutAtMs !== undefined) {
      try {
        const timeoutOutcome = this.store.reclassifyTimedOutInvocation({
          id,
          expectedAttempt: claim.invocation.attempt,
          error: entry.timeoutError,
          timedOutAtMs: entry.timedOutAtMs,
          nowMs: this.now(),
        });
        if (
          timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.retryScheduled ||
          timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.terminal ||
          timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.terminalPaused
        ) {
          if (entry.forceKillTimer !== undefined) {
            clearTimeout(entry.forceKillTimer);
            entry.forceKillTimer = undefined;
          }
          this.running.delete(id);
          this.logger.error(
            `invocation ${id} 超时后迟到写入成功结果，已按失败重分类：${timeoutOutcome}`,
          );
          this.wake.resolve();
          return;
        }
        if (timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.treeUnsettled) {
          timeoutTreeUnsettled = true;
          if (entry.forceKillTimer !== undefined) {
            clearTimeout(entry.forceKillTimer);
            entry.forceKillTimer = undefined;
          }
          this.running.delete(id);
          this.logger.error(
            `invocation ${id} 超时结果因进程树未清无法重分类；释放 host entry，running 账本等待 lease 到期后按树门禁复核`,
          );
        }
      } catch (error) {
        this.logger.error(`invocation ${id} 超时结果重分类失败：${errorMessage(error)}`);
      }
    }
    const liveness = this.executorLivenessAfterRootExit(id);
    if (liveness !== EXECUTOR_LIVENESS.descendants && entry.forceKillTimer !== undefined) {
      clearTimeout(entry.forceKillTimer);
      entry.forceKillTimer = undefined;
    }
    if (timeoutTreeUnsettled) {
      this.wake.resolve();
      return;
    }
    if (liveness !== EXECUTOR_LIVENESS.dead) {
      this.running.delete(id);
      this.logger.error(
        liveness === EXECUTOR_LIVENESS.descendants
          ? entry.forceKillTimer !== undefined
            ? `invocation ${id} 的 exec root 已退出，但进程树仍有存活成员；保留 running，等待已排定的进程树升级`
            : `invocation ${id} 的 exec root 已退出，但进程树仍有存活成员；释放 host entry，保留 running，达到运行上限后由孤儿清理按树门禁复核`
          : entry.treeKillUnconfirmed
            ? `invocation ${id} 的 exec root 已退出，但此前进程树终止未被确认，executor 探活为 ${liveness}；不对 numeric PGID 发信号，账本保持 running`
            : `invocation ${id} 的 exec root 已退出，但 executor 探活为 ${liveness}；不对 numeric PGID 发信号，账本保持 running`,
      );
      this.wake.resolve();
      return;
    }
    let outcome: ReturnType<ScheduleStore["failInvocation"]>;
    try {
      outcome = this.store.failInvocation(
        id,
        claim.ownershipToken,
        entry.timeoutError ??
          `exec 进程退出 code=${code === null ? "null" : String(code)}，未写入执行结果`,
        this.now(),
      );
    } catch (error) {
      this.logger.error(`invocation ${id} 退出后写账本失败：${errorMessage(error)}`);
      this.wake.resolve();
      return;
    }
    if (outcome === INVOCATION_FAILURE_OUTCOMES.treeUnsettled) {
      this.running.delete(id);
      this.logger.error(
        `invocation ${id} 的 exec 已退出，但登记的进程树未清干净；释放 host entry，running 账本不再续租，lease 到期后按树门禁复核，可用 roll schedule cancel ${id} --kill 清场`,
      );
      this.wake.resolve();
      return;
    }
    this.running.delete(id);
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

  private signalChild(id: string, signal: "SIGTERM" | "SIGKILL"): void {
    const entry = this.running.get(id);
    if (entry === undefined) {
      return;
    }
    this.signalEntry(id, entry, signal);
  }

  private signalEntry(id: string, entry: RunningInvocation, signal: "SIGTERM" | "SIGKILL"): void {
    const outcome = entry.handle.kill(signal);
    if (typeof outcome !== "string") {
      return;
    }
    if (outcome !== KILL_PROCESS_TREE_OUTCOMES.tree) {
      entry.treeKillUnconfirmed = true;
      this.logger.error(
        `invocation ${id} 的 exec 进程树未能整体终止（${outcome}）；退出后将保留 running 而不重试`,
      );
      return;
    }
    if (entry.treeKillUnconfirmed) {
      entry.treeKillUnconfirmed = false;
      this.logger.info(`invocation ${id} 的 exec 进程树已在后续 ${signal} 中整体终止`);
    }
  }

  private executorLivenessAfterRootExit(id: string): ExecutorLiveness {
    let record: ReturnType<ScheduleStore["getInvocation"]>;
    try {
      record = this.store.getInvocation(id);
    } catch (error) {
      this.logger.error(`invocation ${id} 退出后读取账本失败：${errorMessage(error)}`);
      return EXECUTOR_LIVENESS.unknown;
    }
    if (record === undefined || record.status !== "running") {
      return EXECUTOR_LIVENESS.dead;
    }
    if (record.executor === undefined) {
      return EXECUTOR_LIVENESS.unknown;
    }
    try {
      return this.store.probeExecutor(record.executor);
    } catch (error) {
      this.logger.error(`invocation ${id} 的 executor 探活失败：${errorMessage(error)}`);
      return EXECUTOR_LIVENESS.unknown;
    }
  }

  private settleStoppedInvocation(
    id: string,
    entry: RunningInvocation,
    reason: string = "daemon 停止时已终止 exec 进程树",
  ): void {
    let record: ReturnType<ScheduleStore["getInvocation"]>;
    try {
      record = this.store.getInvocation(id);
    } catch (error) {
      this.logger.error(`invocation ${id} 停止后读取账本失败：${errorMessage(error)}`);
      return;
    }
    if (
      record?.status !== "running" ||
      this.executorLivenessAfterRootExit(id) !== EXECUTOR_LIVENESS.dead
    ) {
      return;
    }
    let outcome: ReturnType<ScheduleStore["failInvocation"]>;
    try {
      outcome = this.store.failInvocation(id, entry.ownershipToken, reason, this.now());
    } catch (error) {
      this.logger.error(`invocation ${id} 停止后写账本失败：${errorMessage(error)}`);
      return;
    }
    if (outcome === INVOCATION_FAILURE_OUTCOMES.treeUnsettled) {
      this.logger.error(`invocation ${id} 的 exec 已停止但登记进程树未清，继续保持 running`);
      return;
    }
    this.running.delete(id);
  }

  private renewLeases(): void {
    for (const [id, entry] of this.running) {
      if (!this.store.renewLease(id, entry.ownershipToken, this.now())) {
        this.logger.error(`invocation ${id} 的 lease 已丢失，子进程结果将被忽略`);
      }
    }
  }

  private boundOrphans(): void {
    const terminateExecutor = this.terminateExecutor;
    if (terminateExecutor === undefined) {
      return;
    }
    const nowMs = this.now();
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
        this.terminatingOrphans.has(row.id) ||
        row.executor === undefined ||
        row.startedAtMs === undefined
      ) {
        continue;
      }
      const maxRunMs = this.resolveMaxRunMs(row.scheduleId);
      if (maxRunMs === undefined) {
        continue;
      }
      if (row.startedAtMs > nowMs - maxRunMs) {
        continue;
      }
      this.terminatingOrphans.add(row.id);
      const executor = row.executor;
      terminateExecutorWithGrace(executor, {
        platform: this.platform,
        graceMs: this.childTerminateGraceMs,
        unrefWait: true,
        terminate: terminateExecutor,
      })
        .then((outcome) => {
          this.logger.error(
            `invocation ${row.id} 的 exec 进程 (pid ${String(executor.pid)}) 不属于本 daemon 且运行超过 ${String(maxRunMs)} ms，终止结果：${outcome}`,
          );
        })
        .catch((error: unknown) => {
          this.logger.error(`invocation ${row.id} 的超时孤儿清理失败：${errorMessage(error)}`);
        })
        .finally(() => {
          this.terminatingOrphans.delete(row.id);
        });
    }
  }

  private noteAdmission(refused: boolean): void {
    if (refused === this.admissionRefused) {
      return;
    }
    this.admissionRefused = refused;
    if (refused) {
      this.logger.error(
        "scheduler admission 拒绝领取新任务：service metadata 处于 installing 或无法解析，或另一个 scheduler 维护操作持有锁；在恢复前不会触发任何任务。用 roll schedule service status 查看原因，必要时 roll schedule service restart",
      );
      return;
    }
    this.logger.info("scheduler admission 已恢复，继续领取到期任务");
  }

  private resolveMaxRunMs(scheduleId: string): number | undefined {
    try {
      const schedule = this.store.getSchedule(scheduleId);
      if (schedule === undefined) {
        this.noteScheduleCapLookupError(
          scheduleId,
          `schedule ${scheduleId} 不存在，运行上限未知；跳过孤儿清理`,
        );
        return undefined;
      }
      this.scheduleCapLookupErrors.delete(scheduleId);
      return schedule.maxRunMs ?? this.maxRunMs;
    } catch (error) {
      this.noteScheduleCapLookupError(
        scheduleId,
        `读取 schedule ${scheduleId} 的运行上限失败：${errorMessage(error)}；跳过孤儿清理`,
      );
      return undefined;
    }
  }

  private noteScheduleCapLookupError(scheduleId: string, message: string): void {
    if (this.scheduleCapLookupErrors.has(scheduleId)) {
      return;
    }
    this.scheduleCapLookupErrors.add(scheduleId);
    this.logger.error(message);
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
    const targets = [...this.running.entries()];
    if (this.urgentStop) {
      for (const [id, entry] of targets) {
        this.logger.error(`invocation ${id}：紧急停止，不等待 grace，立即强制终止 exec 进程树`);
        this.signalEntry(id, entry, "SIGKILL");
      }
      await settleWithin(
        targets.map(([, entry]) => entry.handle.exited),
        this.urgentStopSettleMs,
      );
      for (const [id, entry] of targets) {
        this.settleStoppedInvocation(id, entry);
      }
      this.releaseUnconfirmed();
      return;
    }
    if (this.platform === "win32") {
      if (targets.length > 0) {
        this.logger.info(
          `Windows 没有优雅终止信号，等待 ${String(this.childTerminateGraceMs)} ms grace 后强制终止 exec 进程树`,
        );
      }
    } else {
      for (const [id, entry] of targets) {
        this.signalEntry(id, entry, "SIGTERM");
      }
    }
    await settleWithin(
      targets.map(([, entry]) => entry.handle.exited),
      this.childTerminateGraceMs,
    );
    const forceTargets = targets.filter(([id, entry]) => {
      const current = this.running.get(id);
      return (
        (current === entry && !entry.rootExited) ||
        this.executorLivenessAfterRootExit(id) === EXECUTOR_LIVENESS.descendants
      );
    });
    if (forceTargets.length === 0) {
      return;
    }
    for (const [id, entry] of forceTargets) {
      this.logger.error(
        `invocation ${id} 的 exec 子进程在 ${String(this.childTerminateGraceMs)} ms 内未退出，发送 SIGKILL`,
      );
      this.signalEntry(id, entry, "SIGKILL");
    }
    await settleWithin(
      forceTargets.map(([, entry]) => entry.handle.exited),
      this.childTerminateGraceMs,
    );
    for (const [id, entry] of forceTargets) {
      this.settleStoppedInvocation(id, entry);
    }
    this.releaseUnconfirmed();
  }

  private releaseUnconfirmed(): void {
    for (const [id, entry] of this.running) {
      clearTimeout(entry.runTimer);
      if (entry.forceKillTimer !== undefined) {
        clearTimeout(entry.forceKillTimer);
      }
      this.running.delete(id);
      this.logger.error(
        `invocation ${id} 的 exec 子进程退出未确认，lease 到期后由探活决定是否重跑`,
      );
    }
  }
}
