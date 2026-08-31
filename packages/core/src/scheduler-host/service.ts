import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createBundledRollInvocation,
  type BundledRollInvocation,
} from "../companion-host/invocation.ts";
import {
  CANCEL_INVOCATION_OUTCOMES,
  EXECUTOR_LIVENESS,
  type ExecutorIdentity,
  type ExecutorLiveness,
  type ScheduleStore,
} from "@roll-agent/runtime";
import {
  createPlatformServiceController,
  type CompanionServiceController,
  type ServicePlanIdentity,
} from "../companion-host/service.ts";
import { expandTilde } from "../config/loader.ts";
import { schedulerConfigSchema } from "../config/schema.ts";
import { AgentLifecycleBusyError, acquireAgentLifecycleLock } from "../registry/process-manager.ts";
import { isDaemonWorkerId, isInlineWorkerId } from "./daemon-record.ts";
import {
  KILL_PROCESS_TREE_OUTCOMES,
  terminateExecutorWithGrace,
  type KillProcessTreeOutcome,
} from "./executor-liveness.ts";
import {
  SCHEDULER_SERVICE_LABEL,
  SCHEDULER_DAEMON_LOCK_NAME,
  WINDOWS_SCHEDULER_TASK_NAME,
  createSchedulerPaths,
  type SchedulerPaths,
} from "./paths.ts";

export interface SchedulerServiceSettings {
  readonly maxConcurrentRuns: number;
  readonly generation?: string;
}

export interface SchedulerServiceInstallSettings {
  readonly dataDir: string;
  readonly maxConcurrentRuns: number;
}

const SCHEDULER_SERVICE_MANAGEMENT_LOCK_NAME = `${String.fromCharCode(0)}roll-scheduler-service-management`;

function acquireSchedulerLock(
  dataDir: string,
  lockName: string,
  busyMessage: string,
): ReturnType<typeof acquireAgentLifecycleLock> {
  try {
    return acquireAgentLifecycleLock(dataDir, lockName);
  } catch (error) {
    if (error instanceof AgentLifecycleBusyError) {
      throw new Error(busyMessage);
    }
    throw error;
  }
}

function daemonFenceBusyMessage(dataDir: string, taskRetained: boolean): string {
  return `已有 roll schedule daemon 在 ${dataDir} 运行${taskRetained ? "，Scheduled Task 已保留为 disabled" : ""}；先停止该 daemon（roll schedule status 可查看）再重试`;
}

export function defaultSchedulerServiceSettings(): SchedulerServiceInstallSettings {
  const defaults = schedulerConfigSchema.parse({});
  return {
    dataDir: createSchedulerPaths(expandTilde(defaults.dataDir)).dataDir,
    maxConcurrentRuns: defaults.maxConcurrentRuns,
  };
}

export async function withSchedulerServiceManagementLock<T>(
  work: () => Promise<T>,
  homeDir: string = homedir(),
): Promise<T> {
  const lock = acquireSchedulerLock(
    resolve(homeDir, ".roll-agent"),
    SCHEDULER_SERVICE_MANAGEMENT_LOCK_NAME,
    "另一个 roll schedule service install / uninstall / restart / update 正在执行，请稍后重试",
  );
  try {
    return await work();
  } finally {
    lock.release();
  }
}

export function schedulerServiceIdentity(
  paths: SchedulerPaths,
  invocation: BundledRollInvocation,
  settings: SchedulerServiceSettings,
): ServicePlanIdentity {
  return {
    label: SCHEDULER_SERVICE_LABEL,
    plistPath: paths.launchAgentPath,
    logPath: paths.logPath,
    windowsTaskName: WINDOWS_SCHEDULER_TASK_NAME,
    displayName: "roll schedule daemon",
    windowsTaskXmlPath: paths.windowsTaskXmlPath,
    programArguments: [
      invocation.command,
      ...invocation.execArgv,
      invocation.cliEntrypoint,
      "schedule",
      "daemon",
      "--foreground",
      "--data-dir",
      paths.dataDir,
      "--max-concurrent-runs",
      String(settings.maxConcurrentRuns),
      ...(settings.generation === undefined ? [] : ["--service-generation", settings.generation]),
    ],
  };
}

export function createSchedulerServiceController(options: {
  readonly dataDir: string;
  readonly maxConcurrentRuns: number;
  readonly generation?: string;
  readonly invocation?: BundledRollInvocation;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}): CompanionServiceController {
  const paths = createSchedulerPaths(options.dataDir, options.homeDir);
  const invocation = options.invocation ?? createBundledRollInvocation();
  return createPlatformServiceController({
    identity: schedulerServiceIdentity(paths, invocation, {
      maxConcurrentRuns: options.maxConcurrentRuns,
      ...(options.generation === undefined ? {} : { generation: options.generation }),
    }),
    ...(options.platform ? { platform: options.platform } : {}),
  });
}

export async function installSchedulerServiceControllerSafely(
  controller: CompanionServiceController,
  verifyReady?: () => Promise<void>,
): Promise<void> {
  try {
    await controller.install();
    await verifyReady?.();
  } catch (installError) {
    let installed: boolean | undefined;
    let statusError: unknown;
    try {
      const status = await controller.status();
      installed = status.installed;
    } catch (error) {
      statusError = error;
    }
    if (installed === false) {
      throw installError;
    }
    try {
      if (controller.disable !== undefined) {
        await controller.disable();
        await controller.stop();
      } else {
        await controller.uninstall();
      }
    } catch (cleanupError) {
      throw new AggregateError(
        statusError === undefined
          ? [installError, cleanupError]
          : [installError, statusError, cleanupError],
        "scheduler service install failed and its partial registration could not be stopped",
      );
    }
    throw installError;
  }
}

type WindowsSchedulerServiceStore = Pick<
  ScheduleStore,
  | "cancelInvocation"
  | "getInvocation"
  | "listActiveWorkerInvocations"
  | "listOccupyingInvocations"
  | "prepareWorkerShutdown"
  | "probeExecutor"
>;

export interface OpenedWindowsSchedulerServiceStore {
  readonly store: WindowsSchedulerServiceStore;
  close(): void;
}

export interface UninstallWindowsSchedulerServiceOptions {
  readonly controller: CompanionServiceController;
  readonly openStore: () => Promise<OpenedWindowsSchedulerServiceStore>;
  readonly dataDir: string;
  readonly now?: () => number;
  readonly terminateExecutor?: (executor: ExecutorIdentity) => Promise<KillProcessTreeOutcome>;
  readonly waitForExecutorExit?: (
    executor: ExecutorIdentity,
    timeoutMs: number,
  ) => Promise<ExecutorLiveness>;
  readonly onUninstalled?: () => void;
}

const WINDOWS_EXECUTOR_STOP_TIMEOUT_MS = 5_000;
const WINDOWS_EXECUTOR_STOP_POLL_MS = 100;

async function waitForExecutorExit(
  store: Pick<WindowsSchedulerServiceStore, "probeExecutor">,
  executor: ExecutorIdentity,
  timeoutMs: number,
): Promise<ExecutorLiveness> {
  const deadline = Date.now() + timeoutMs;
  let liveness = store.probeExecutor(executor);
  while (liveness !== EXECUTOR_LIVENESS.dead && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WINDOWS_EXECUTOR_STOP_POLL_MS, deadline - Date.now())),
    );
    liveness = store.probeExecutor(executor);
  }
  return liveness;
}

async function cleanupWindowsSchedulerService(
  options: UninstallWindowsSchedulerServiceOptions,
  store: WindowsSchedulerServiceStore,
): Promise<void> {
  const active = store.listOccupyingInvocations();
  const workerIds = new Set(active.map((row) => row.claimedBy).filter(isDaemonWorkerId));
  const unattributed = active.filter(
    (row) =>
      row.claimedBy === undefined ||
      (!isDaemonWorkerId(row.claimedBy) && !isInlineWorkerId(row.claimedBy)),
  );
  const running = [...workerIds].flatMap((workerId) =>
    store.prepareWorkerShutdown(
      workerId,
      "scheduler service 已停止，取消本 daemon 尚未完成的 invocation",
      (options.now ?? Date.now)(),
    ),
  );
  const terminate =
    options.terminateExecutor ??
    ((executor: ExecutorIdentity) => terminateExecutorWithGrace(executor, { platform: "win32" }));
  const waitForExit =
    options.waitForExecutorExit ??
    ((executor: ExecutorIdentity, timeoutMs: number) =>
      waitForExecutorExit(store, executor, timeoutMs));
  const failures = unattributed.map((row) => `invocation ${row.id} 的 worker identity 无法归类`);
  for (const claim of running) {
    const executor = claim.invocation.executor;
    if (executor === undefined) {
      failures.push(`invocation ${claim.invocation.id} 缺少 executor identity`);
      continue;
    }
    let liveness = store.probeExecutor(executor);
    if (liveness === EXECUTOR_LIVENESS.unknown) {
      failures.push(`invocation ${claim.invocation.id} 的 executor identity 无法验证`);
      continue;
    }
    if (liveness !== EXECUTOR_LIVENESS.dead) {
      const outcome = await terminate(executor);
      if (outcome !== KILL_PROCESS_TREE_OUTCOMES.tree) {
        failures.push(
          `invocation ${claim.invocation.id} 的 exec 进程树未确认退出（pid ${String(executor.pid)}）`,
        );
        continue;
      }
      liveness = await waitForExit(executor, WINDOWS_EXECUTOR_STOP_TIMEOUT_MS);
      if (liveness !== EXECUTOR_LIVENESS.dead) {
        failures.push(
          `invocation ${claim.invocation.id} 的 exec 进程树未确认退出（pid ${String(executor.pid)}）`,
        );
        continue;
      }
    }
    const cancelled = store.cancelInvocation(
      claim.invocation.id,
      "scheduler service 已停止，取消本 daemon 尚未完成的 invocation",
      (options.now ?? Date.now)(),
      { expectedOwnershipToken: claim.ownershipToken },
    );
    if (cancelled === CANCEL_INVOCATION_OUTCOMES.ownershipChanged) {
      const current = store.getInvocation(claim.invocation.id);
      if (current !== undefined && isDaemonWorkerId(current.claimedBy)) {
        failures.push(
          `invocation ${claim.invocation.id} 已被 ${current.claimedBy} 重新接管，未收尾`,
        );
      }
      continue;
    }
    if (
      cancelled !== CANCEL_INVOCATION_OUTCOMES.cancelled &&
      cancelled !== CANCEL_INVOCATION_OUTCOMES.terminal
    ) {
      failures.push(`invocation ${claim.invocation.id} 收尾失败（${cancelled}），ownership 已保留`);
    }
  }
  const remainingDaemonWork = store
    .listOccupyingInvocations()
    .filter((row) => !isInlineWorkerId(row.claimedBy));
  if (remainingDaemonWork.length > 0) {
    failures.push(`${String(remainingDaemonWork.length)} 个 daemon invocation 在收尾后仍为 live`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Windows scheduler service 停止不完整，Scheduled Task 已保留为 disabled：${failures.join("；")}`,
    );
  }
  await options.controller.uninstall();
  options.onUninstalled?.();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function uninstallWindowsSchedulerServiceWithoutLedger(
  options: UninstallWindowsSchedulerServiceOptions,
): Promise<void> {
  await options.controller.uninstall();
  options.onUninstalled?.();
}

async function cleanupOrUninstallWindowsSchedulerService(
  options: UninstallWindowsSchedulerServiceOptions,
): Promise<void> {
  const ledgerPath = join(options.dataDir, "schedules.db");
  if (!existsSync(ledgerPath)) {
    await uninstallWindowsSchedulerServiceWithoutLedger(options);
    return;
  }
  let opened: OpenedWindowsSchedulerServiceStore;
  try {
    opened = await options.openStore();
  } catch (error) {
    throw new Error(
      `无法打开权威账本 ${ledgerPath}：${errorMessage(error)}；确认没有 roll schedule daemon / exec 存活后，移走或删除该文件再重试 uninstall（账本不存在时会直接删除 Scheduled Task）`,
      { cause: error },
    );
  }
  try {
    await cleanupWindowsSchedulerService(options, opened.store);
  } finally {
    opened.close();
  }
}

export async function uninstallWindowsSchedulerService(
  options: UninstallWindowsSchedulerServiceOptions,
): Promise<void> {
  const serviceStatus = await options.controller.status();
  if (serviceStatus.installed) {
    if (options.controller.disable === undefined) {
      throw new Error("Windows scheduler service controller cannot disable its Scheduled Task");
    }
    await options.controller.disable();
    await options.controller.stop();
  }
  if (!existsSync(options.dataDir)) {
    await uninstallWindowsSchedulerServiceWithoutLedger(options);
    return;
  }
  const daemonFence = acquireSchedulerLock(
    options.dataDir,
    SCHEDULER_DAEMON_LOCK_NAME,
    daemonFenceBusyMessage(options.dataDir, serviceStatus.installed),
  );
  try {
    await cleanupOrUninstallWindowsSchedulerService(options);
  } finally {
    daemonFence.release();
  }
}

export type RollbackInstallingWindowsSchedulerServiceOptions =
  UninstallWindowsSchedulerServiceOptions;

export async function rollbackInstallingWindowsSchedulerService(
  options: RollbackInstallingWindowsSchedulerServiceOptions,
): Promise<void> {
  let installed: boolean | undefined;
  let statusError: unknown;
  try {
    installed = (await options.controller.status()).installed;
  } catch (error) {
    statusError = error;
  }
  if (installed !== false) {
    try {
      if (options.controller.disable === undefined) {
        throw new Error("Windows scheduler service controller cannot disable its Scheduled Task");
      }
      await options.controller.disable();
      await options.controller.stop();
    } catch (cleanupError) {
      throw new AggregateError(
        statusError === undefined ? [cleanupError] : [statusError, cleanupError],
        "installing Windows scheduler service could not be quiesced for rollback",
      );
    }
  }
  if (!existsSync(options.dataDir)) {
    await uninstallWindowsSchedulerServiceWithoutLedger(options);
    return;
  }
  const daemonFence = acquireSchedulerLock(
    options.dataDir,
    SCHEDULER_DAEMON_LOCK_NAME,
    daemonFenceBusyMessage(options.dataDir, installed !== false),
  );
  try {
    await cleanupOrUninstallWindowsSchedulerService(options);
  } finally {
    daemonFence.release();
  }
}
