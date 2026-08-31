import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import type { CompanionServiceController } from "../../companion-host/service.ts";
import type { RollConfig } from "../../config/schema.ts";
import {
  isInlineWorkerId,
  readDaemonRecord,
  removeDaemonRecord,
  waitForDaemonGeneration,
} from "../../scheduler-host/daemon-record.ts";
import {
  AgentLifecycleBusyError,
  acquireAgentLifecycleLock,
  type AgentLifecycleLock,
} from "../../registry/process-manager.ts";
import { SCHEDULER_DAEMON_LOCK_NAME, createSchedulerPaths } from "../../scheduler-host/paths.ts";
import {
  SCHEDULER_REPLACEMENT_OUTCOMES,
  replaceSchedulerServiceWithAdmission,
} from "../../scheduler-host/scheduler-admission.ts";
import {
  SCHEDULER_SERVICE_BINARY_STATUSES,
  describeSchedulerServiceBinary,
  type SchedulerServiceBinaryReport,
} from "../../scheduler-host/service-binary.ts";
import {
  SCHEDULER_SERVICE_INSTALL_ACTIONS,
  SCHEDULER_SERVICE_RESTART_ACTIONS,
  SCHEDULER_SERVICE_UNINSTALL_ACTIONS,
  planSchedulerServiceInstall,
  planSchedulerServiceRestart,
  planSchedulerServiceUninstall,
  type SchedulerServiceInstallAction,
  type SchedulerServiceRestartAction,
  type SchedulerServiceUninstallAction,
} from "../../scheduler-host/service-plan.ts";
import {
  createSchedulerServiceController,
  defaultSchedulerServiceSettings,
  installSchedulerServiceControllerSafely,
  rollbackInstallingWindowsSchedulerService,
  uninstallWindowsSchedulerService,
  type SchedulerServiceInstallSettings,
} from "../../scheduler-host/service.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
  SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
  describeSchedulerServiceStateProblem,
  inspectSchedulerServiceState,
  installSchedulerServiceWithState,
  removeInvalidSchedulerServiceState,
  removeSchedulerServiceState,
  requireSchedulerServiceState,
  schedulerServiceStatePath,
  windowsSchedulerServiceRecoveryHint,
  writeSchedulerServiceState,
  type SchedulerServiceBinary,
  type SchedulerServiceState,
  type SchedulerServiceStateInspection,
  type SchedulerServiceStatePhase,
} from "../../scheduler-host/service-state.ts";
import { getCurrentVersion } from "../utils/update-checker.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, openScheduleStore } from "./schedule-command-utils.ts";

export { withSchedulerServiceManagementLock } from "../../scheduler-host/service.ts";

export async function retireWindowsSchedulerService(
  state: SchedulerServiceState,
  statePath: string,
): Promise<void> {
  const paths = createSchedulerPaths(state.dataDir);
  const options = {
    controller: createSchedulerServiceController(state),
    dataDir: paths.dataDir,
    openStore: async () => {
      const runtime = await loadRuntime();
      const store = openScheduleStore(undefined, runtime, {
        dataDir: paths.dataDir,
        requireExistingDatabase: true,
      });
      return { store, close: () => store.close() };
    },
    onUninstalled: () => {
      const record = readDaemonRecord(paths.daemonRecordPath);
      if (record !== undefined) {
        removeDaemonRecord(paths.daemonRecordPath, record);
      }
      removeSchedulerServiceState(statePath, state);
    },
  };
  if (state.phase === SCHEDULER_SERVICE_STATE_PHASES.installing) {
    await rollbackInstallingWindowsSchedulerService(options);
    return;
  }
  await uninstallWindowsSchedulerService(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function quiesceUnprovenWindowsTask(
  controller: CompanionServiceController,
  inspection: SchedulerServiceStateInspection,
  statePath: string,
): Promise<never> {
  const problem = describeSchedulerServiceStateProblem(
    inspection,
    windowsSchedulerServiceRecoveryHint(statePath),
  );
  try {
    if (controller.disable !== undefined) {
      await controller.disable();
      await controller.stop();
    }
  } catch (error) {
    throw new Error(`${problem}；同时 Disable/Stop 该任务失败：${errorMessage(error)}`, {
      cause: error,
    });
  }
  throw new Error(problem);
}

export async function assertNodeSqliteAvailable(): Promise<void> {
  try {
    await import("node:sqlite");
  } catch {
    throw new Error(
      "当前 Node 进程无法加载 node:sqlite（Node < 22.13 需要 --experimental-sqlite）；请通过 roll 命令安装，或升级 Node",
    );
  }
}

export function currentSchedulerServiceBinary(): SchedulerServiceBinary {
  const invocation = createBundledRollInvocation();
  return {
    command: invocation.command,
    cliEntrypoint: invocation.cliEntrypoint,
    rollVersion: getCurrentVersion(),
  };
}

export function describeInstalledSchedulerServiceBinary(
  state: SchedulerServiceState,
): SchedulerServiceBinaryReport {
  return describeSchedulerServiceBinary(state.binary, currentSchedulerServiceBinary(), existsSync);
}

export interface SchedulerServiceProbe {
  readonly metadataStatus: SchedulerServiceStateInspection["status"];
  readonly metadataPhase?: SchedulerServiceStatePhase;
  readonly installed: boolean;
  readonly running: boolean;
  readonly installedDataDir?: string;
  readonly binary?: SchedulerServiceBinaryReport;
  readonly error?: string;
}

export async function probeSchedulerService(
  options: { readonly platform?: NodeJS.Platform; readonly statePath?: string } = {},
): Promise<SchedulerServiceProbe> {
  const platform = options.platform ?? process.platform;
  const inspection = inspectSchedulerServiceState(options.statePath ?? schedulerServiceStatePath());
  if (platform !== "darwin" && platform !== "win32") {
    return inspection.status === "missing"
      ? { metadataStatus: inspection.status, installed: false, running: false }
      : {
          metadataStatus: inspection.status,
          ...(inspection.status === "valid"
            ? { metadataPhase: inspection.state.phase, installedDataDir: inspection.state.dataDir }
            : {}),
          installed: false,
          running: false,
          error: `当前平台 ${platform} 不支持内建 scheduler service，但发现了 ${inspection.status} metadata`,
        };
  }
  try {
    const status = await createSchedulerServiceController({
      ...(inspection.status === "valid" ? inspection.state : defaultSchedulerServiceSettings()),
      platform,
    }).status();
    return {
      metadataStatus: inspection.status,
      ...(inspection.status === "valid"
        ? { metadataPhase: inspection.state.phase, installedDataDir: inspection.state.dataDir }
        : {}),
      installed: status.installed,
      running: status.running,
      ...(inspection.status === "valid"
        ? { binary: describeInstalledSchedulerServiceBinary(inspection.state) }
        : {}),
      ...(inspection.status === "invalid" ? { error: inspection.error } : {}),
    };
  } catch (error) {
    return {
      metadataStatus: inspection.status,
      ...(inspection.status === "valid"
        ? { metadataPhase: inspection.state.phase, installedDataDir: inspection.state.dataDir }
        : {}),
      installed: false,
      running: false,
      error: errorMessage(error),
    };
  }
}

export async function listSchedulerServiceBlockerIds(
  dataDir: string,
  options: { readonly allowInline?: boolean } = {},
): Promise<readonly string[]> {
  if (!existsSync(join(dataDir, "schedules.db"))) {
    return [];
  }
  const runtime = await loadRuntime();
  const store = openScheduleStore(undefined, runtime, { dataDir, requireExistingDatabase: true });
  try {
    const rows = store.listOccupyingInvocations();
    return (
      options.allowInline === true ? rows.filter((row) => !isInlineWorkerId(row.claimedBy)) : rows
    ).map((row) => row.id);
  } finally {
    store.close();
  }
}

export async function countSchedulerServiceBlockers(
  dataDir: string,
  options: { readonly allowInline?: boolean } = {},
): Promise<number> {
  return (await listSchedulerServiceBlockerIds(dataDir, options)).length;
}

export function describeSchedulerServiceBlockers(ids: readonly string[]): string {
  return `invocation ${ids.join(", ")}；用 roll schedule runs <schedule-id> 查看，roll schedule cancel <invocation-id> --kill 清场`;
}

export function schedulerServiceSettingsFromConfig(
  config: RollConfig,
): SchedulerServiceInstallSettings {
  const nextPaths = createSchedulerPaths(config.scheduler.dataDir);
  return {
    dataDir: nextPaths.dataDir,
    maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
  };
}

export function schedulerServiceTeardownState(state: SchedulerServiceState): SchedulerServiceState {
  return state.replacementFrom ?? state;
}

export async function retireWindowsSchedulerServiceIntent(
  currentState: SchedulerServiceState,
  statePath: string,
  retire: typeof retireWindowsSchedulerService = retireWindowsSchedulerService,
): Promise<void> {
  await retire(schedulerServiceTeardownState(currentState), statePath);
  removeSchedulerServiceState(statePath, currentState);
}

interface InstallSchedulerServiceGenerationDependencies {
  readonly createController?: typeof createSchedulerServiceController;
  readonly installController?: (
    controller: CompanionServiceController,
    verifyReady: () => Promise<void>,
  ) => Promise<void>;
  readonly waitForGeneration?: (path: string, generation: string) => Promise<unknown>;
}

export async function installSchedulerServiceGeneration(
  settings: SchedulerServiceInstallSettings,
  installing: SchedulerServiceState,
  dependencies: InstallSchedulerServiceGenerationDependencies = {},
): Promise<void> {
  const generation = installing.generation;
  if (generation === undefined) {
    throw new Error("scheduler service installing metadata 缺少 generation");
  }
  const controller = (dependencies.createController ?? createSchedulerServiceController)({
    ...settings,
    generation,
  });
  const waitForGeneration = dependencies.waitForGeneration ?? waitForDaemonGeneration;
  const paths = createSchedulerPaths(settings.dataDir);
  await (dependencies.installController ?? installSchedulerServiceControllerSafely)(
    controller,
    async () => {
      try {
        await waitForGeneration(paths.daemonRecordPath, generation);
      } catch (error) {
        throw new Error(`${errorMessage(error)}；daemon 日志：${paths.logPath}`, { cause: error });
      }
    },
  );
}

export function assertSchedulerDaemonStopped(
  dataDir: string,
  acquire: (dataDir: string, lockName: string) => AgentLifecycleLock = acquireAgentLifecycleLock,
): void {
  let lock: AgentLifecycleLock;
  try {
    lock = acquire(dataDir, SCHEDULER_DAEMON_LOCK_NAME);
  } catch (error) {
    if (error instanceof AgentLifecycleBusyError) {
      throw new Error(`data-dir ${dataDir} 仍有 foreground daemon；拒绝安装新的 scheduler service`);
    }
    throw error;
  }
  lock.release();
}

export async function installSchedulerServiceUnlocked(config: RollConfig): Promise<boolean> {
  const hadMetadata = inspectSchedulerServiceState(schedulerServiceStatePath()).status === "valid";
  const result = await applySchedulerServiceSettingsUnlocked(
    schedulerServiceSettingsFromConfig(config),
    { forceReplacement: false, forceLive: false },
  );
  if (result.action === SCHEDULER_SERVICE_INSTALL_ACTIONS.refuseLiveRuns) {
    throw new Error(
      `仍有 ${String(result.liveInvocations)} 个定时任务 invocation 占用（claimed / running，或 retry 持有未清进程树），拒绝${hadMetadata ? "替换" : "安装"} scheduler service；请先等待完成，或用 roll schedule runs <schedule-id> 查看并以 roll schedule cancel <invocation-id> --kill 清场${hadMetadata ? "；替换已安装服务时也可显式使用 roll schedule service restart --force" : ""}`,
    );
  }
  return result.refreshed;
}

interface ApplySchedulerServiceResult {
  readonly action: SchedulerServiceInstallAction;
  readonly liveInvocations: number;
  readonly refreshed: boolean;
}

async function applySchedulerServiceSettingsUnlocked(
  next: SchedulerServiceInstallSettings,
  options: { readonly forceReplacement: boolean; readonly forceLive: boolean },
): Promise<ApplySchedulerServiceResult> {
  const nextPaths = createSchedulerPaths(next.dataDir);
  const statePath = schedulerServiceStatePath();
  const inspection = inspectSchedulerServiceState(statePath);
  const previousState =
    inspection.status === "valid"
      ? (inspection.state.replacementFrom ?? inspection.state)
      : undefined;
  const controller = createSchedulerServiceController(previousState ?? next);
  const binary = currentSchedulerServiceBinary();
  const binaryStale =
    options.forceReplacement ||
    (inspection.status === "valid" &&
      (inspection.state.generation === undefined ||
        describeSchedulerServiceBinary(inspection.state.binary, binary, existsSync).status !==
          SCHEDULER_SERVICE_BINARY_STATUSES.current));
  const status = await controller.status();
  const action = planSchedulerServiceInstall({
    platform: process.platform,
    inspection,
    next,
    status,
    binaryStale,
  });
  mkdirSync(nextPaths.dataDir, { recursive: true, mode: 0o700 });
  const targetState = {
    schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
    ...next,
    binary,
  } as const;
  const installFresh = async (): Promise<void> => {
    await installSchedulerServiceWithState(statePath, targetState, async (installing) => {
      assertSchedulerDaemonStopped(next.dataDir);
      await installSchedulerServiceGeneration(next, installing);
    });
  };
  const replaceAndInstall = async (teardown: () => Promise<void>): Promise<void> => {
    await installSchedulerServiceWithState(
      statePath,
      targetState,
      async (installing) => {
        await teardown();
        if (previousState !== undefined && previousState.dataDir !== next.dataDir) {
          assertSchedulerDaemonStopped(previousState.dataDir);
        }
        assertSchedulerDaemonStopped(next.dataDir);
        await installSchedulerServiceGeneration(next, installing);
      },
      { ...(previousState === undefined ? {} : { replacementFrom: previousState }) },
    );
  };
  const handlers: Record<
    SchedulerServiceInstallAction,
    () => Promise<ApplySchedulerServiceResult>
  > = {
    [SCHEDULER_SERVICE_INSTALL_ACTIONS.refresh]: async () => {
      const state = requireSchedulerServiceState(inspection);
      await installSchedulerServiceGeneration(next, state);
      writeSchedulerServiceState(statePath, {
        ...state,
        binary,
      });
      return { action, liveInvocations: 0, refreshed: true };
    },
    [SCHEDULER_SERVICE_INSTALL_ACTIONS.retire]: async () => {
      await replaceAndInstall(() =>
        retireWindowsSchedulerService(
          previousState ?? requireSchedulerServiceState(inspection),
          statePath,
        ),
      );
      return { action, liveInvocations: 0, refreshed: false };
    },
    [SCHEDULER_SERVICE_INSTALL_ACTIONS.replace]: async () => {
      await replaceAndInstall(async () => {
        await controller.uninstall();
        if (previousState !== undefined) {
          const remaining = await listSchedulerServiceBlockerIds(previousState.dataDir, {
            allowInline: true,
          });
          if (remaining.length > 0 && !options.forceLive) {
            throw new Error(
              `旧 scheduler service 停止后仍有 ${String(remaining.length)} 个 invocation 占用，拒绝安装新 service（metadata 保持 installing，领取已阻塞）：${describeSchedulerServiceBlockers(remaining)}；清场后重新运行 roll schedule service restart，或加 --force 让新 daemon 按探活与 max-run 接管残留`,
            );
          }
          if (remaining.length > 0) {
            log.warn(
              `旧 scheduler service 停止后仍有 ${String(remaining.length)} 个 invocation 占用，--force 继续安装，残留由新 daemon 按探活与 max-run 处理：${describeSchedulerServiceBlockers(remaining)}`,
            );
          }
        }
        removeSchedulerServiceState(
          statePath,
          previousState ?? requireSchedulerServiceState(inspection),
        );
      });
      return { action, liveInvocations: 0, refreshed: false };
    },
    [SCHEDULER_SERVICE_INSTALL_ACTIONS.failClosed]: () =>
      process.platform === "win32"
        ? quiesceUnprovenWindowsTask(controller, inspection, statePath)
        : Promise.reject(
            new Error(
              describeSchedulerServiceStateProblem(
                inspection,
                "已发现 LaunchAgent，但缺少可验证 metadata，无法证明旧 data-dir 与运行状态；请先确认旧 daemon 状态（roll schedule status），运行 roll schedule service uninstall 卸载后再 install",
              ),
            ),
          ),
    [SCHEDULER_SERVICE_INSTALL_ACTIONS.install]: async () => {
      await installFresh();
      return { action, liveInvocations: 0, refreshed: false };
    },
    [SCHEDULER_SERVICE_INSTALL_ACTIONS.refuseLiveRuns]: async () => ({
      action: SCHEDULER_SERVICE_INSTALL_ACTIONS.refuseLiveRuns,
      liveInvocations: 0,
      refreshed: false,
    }),
  };
  const admissionActions: readonly SchedulerServiceInstallAction[] = [
    SCHEDULER_SERVICE_INSTALL_ACTIONS.install,
    SCHEDULER_SERVICE_INSTALL_ACTIONS.retire,
    SCHEDULER_SERVICE_INSTALL_ACTIONS.replace,
  ];
  if (!admissionActions.includes(action)) {
    return handlers[action]();
  }
  const quiesced = process.platform === "win32" && status.installed && status.enabled === false;
  const admissionDataDir = previousState?.dataDir ?? nextPaths.dataDir;
  const replacement = await replaceSchedulerServiceWithAdmission({
    force: options.forceLive || quiesced,
    countLive: () =>
      countSchedulerServiceBlockers(admissionDataDir, {
        allowInline: action === SCHEDULER_SERVICE_INSTALL_ACTIONS.install,
      }),
    replace: async () => {
      await handlers[action]();
    },
  });
  return replacement.outcome === SCHEDULER_REPLACEMENT_OUTCOMES.refusedLiveRuns
    ? {
        action: SCHEDULER_SERVICE_INSTALL_ACTIONS.refuseLiveRuns,
        liveInvocations: replacement.liveInvocations,
        refreshed: false,
      }
    : { action, liveInvocations: replacement.liveInvocations, refreshed: false };
}

export async function uninstallSchedulerServiceUnlocked(): Promise<boolean> {
  const statePath = schedulerServiceStatePath();
  const inspection = inspectSchedulerServiceState(statePath);
  const fallbackController = createSchedulerServiceController(defaultSchedulerServiceSettings());
  const taskInstalled =
    inspection.status !== "valid" ? (await fallbackController.status()).installed : false;
  const action = planSchedulerServiceUninstall({
    platform: process.platform,
    inspection,
    taskInstalled,
  });
  const handlers: Record<SchedulerServiceUninstallAction, () => Promise<boolean>> = {
    [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.retire]: async () => {
      const currentState = requireSchedulerServiceState(inspection);
      await retireWindowsSchedulerServiceIntent(currentState, statePath);
      return true;
    },
    [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByMetadata]: async () => {
      const state = requireSchedulerServiceState(inspection);
      await createSchedulerServiceController(state).uninstall();
      removeSchedulerServiceState(statePath, state);
      return true;
    },
    [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByDefaults]: async () => {
      await fallbackController.uninstall();
      removeInvalidSchedulerServiceState(statePath);
      return true;
    },
    [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.failClosed]: () =>
      quiesceUnprovenWindowsTask(fallbackController, inspection, statePath),
    [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.nothingInstalled]: async () => {
      if (removeInvalidSchedulerServiceState(statePath)) {
        log.warn("已清除无效的 scheduler service metadata（未发现已安装的 Scheduled Task）");
      }
      return false;
    },
  };
  return handlers[action]();
}

export interface RestartSchedulerServiceResult {
  readonly action: SchedulerServiceRestartAction;
  readonly liveInvocations: number;
}

export async function restartSchedulerServiceUnlocked(input: {
  readonly config: RollConfig;
  readonly force: boolean;
}): Promise<RestartSchedulerServiceResult> {
  return restartSchedulerServiceWithSettingsUnlocked({
    settings: schedulerServiceSettingsFromConfig(input.config),
    force: input.force,
  });
}

export async function restartInstalledSchedulerServiceUnlocked(input: {
  readonly force: boolean;
}): Promise<RestartSchedulerServiceResult> {
  return restartSchedulerServiceWithSettingsUnlocked({ force: input.force });
}

async function restartSchedulerServiceWithSettingsUnlocked(input: {
  readonly settings?: SchedulerServiceInstallSettings;
  readonly force: boolean;
}): Promise<RestartSchedulerServiceResult> {
  const inspection = inspectSchedulerServiceState(schedulerServiceStatePath());
  const initialAction = planSchedulerServiceRestart({
    inspection,
    liveInvocations: 0,
    force: input.force,
  });
  if (
    initialAction !== SCHEDULER_SERVICE_RESTART_ACTIONS.restart ||
    inspection.status !== "valid"
  ) {
    return { action: initialAction, liveInvocations: 0 };
  }
  const settings = input.settings ?? {
    dataDir: inspection.state.dataDir,
    maxConcurrentRuns: inspection.state.maxConcurrentRuns,
  };
  const replacement = await applySchedulerServiceSettingsUnlocked(settings, {
    forceReplacement: true,
    forceLive: input.force,
  });
  return {
    action:
      replacement.action === SCHEDULER_SERVICE_INSTALL_ACTIONS.refuseLiveRuns
        ? SCHEDULER_SERVICE_RESTART_ACTIONS.refuseLiveRuns
        : SCHEDULER_SERVICE_RESTART_ACTIONS.restart,
    liveInvocations: replacement.liveInvocations,
  };
}

export function describeSchedulerServiceRestartRefusal(
  result: RestartSchedulerServiceResult,
): string {
  return result.action === SCHEDULER_SERVICE_RESTART_ACTIONS.notInstalled
    ? "未发现已安装的 roll schedule daemon 用户服务（或 metadata 无效）；请运行 roll schedule service install"
    : `有 ${String(result.liveInvocations)} 个定时任务 invocation 仍在占用（claimed / running，或 retry 持有未清进程树），未重启；等待运行完成、按 runs 提示用 cancel --kill 清场，或加 --force 强制重启（会中断 daemon-owned invocation；run-now --inline 不受影响）`;
}
