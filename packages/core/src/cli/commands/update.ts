import { defineCommand } from "citty";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  inspectConfigFile,
  loadAgentsConfig,
  loadConfig,
  loadInstallConfig,
  type ConfigInspectionResult,
} from "../../config/loader.ts";
import { DEFAULT_CONFIG } from "../../config/defaults.ts";
import { getAgentEnv } from "../../config/helpers.ts";
import {
  MANAGED_AGENT_RUNTIME_RETENTIONS,
  getAgentPid,
  readVerifiedManagedAgentRuntime,
  startAgent,
  stopAgentGracefully,
  waitForAgentReady,
  type AgentLifecycleLock,
  type ManagedAgentRuntimeRetention,
} from "../../registry/process-manager.ts";
import {
  acquireAgentUsageMaintenanceGuard,
  type AgentUsageMaintenanceGuard,
} from "../../registry/agent-usage-lease.ts";
import { resolveTransportWithDevSpawnSpec } from "../../registry/dev-spawn.ts";
import { AgentStore, readAgentStoreEntryCount } from "../../registry/store.ts";
import {
  acquireAgentRegistryLockAsync,
  type AgentRegistryLock,
} from "../../registry/agent-registry-lock.ts";
import { getInstallDirectoryBackupPath } from "../../registry/install-directory-backup.ts";
import {
  INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS,
  INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS,
  INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS,
} from "../../registry/installed-package-replacement.ts";
import {
  AgentUpdateNameChangedError,
  INSTALLED_PACKAGE_UPDATE_PHASES,
  discoverUpdatedAgent,
  updateInstalledPackage,
  type InstalledPackageUpdateEvent,
} from "../../registry/installed-package-update.ts";
import {
  inferAgentSourceType,
  readInstalledPackageManifest,
  resolveInstalledPackageRoot,
} from "../../registry/source.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { log, createSpinner } from "../utils/output.ts";
import {
  checkForUpdate,
  checkPublishedPackageUpdate,
  getCurrentVersion,
  isPinnedPublishedPackageSpec,
  type PublishedPackageUpdateInfo,
  type PublishedPackageUpdateStatus,
} from "../utils/update-checker.ts";
import {
  buildNpmRetryPolicy,
  detectInstallCommand,
  formatPackageManagerError,
  npmInstallNetworkArgs,
  runPackageManager,
  runPackageManagerWithRetry,
  type PackageManagerRunSpec,
} from "../utils/package-manager.ts";
import type { AgentSourceType, RegisteredAgent } from "../../types/agent.ts";
import type { RollConfig } from "../../config/schema.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import {
  getExecutionEnvironment,
  withExecutionEnvironment,
  type ExecutionEnvironment,
} from "../../execution-environment/index.ts";
import {
  resolveSelfUpdateTarget,
  type SelfUpdateTarget,
} from "../../execution-environment/self-update.ts";
import {
  DistributionUpdateInterruptedError,
  fetchDistributionManifest,
  prepareDistributionUpdate,
  type PreparedDistribution,
} from "../../execution-environment/distribution.ts";
import { acquireSchedulerAdmissionLockWithRetry } from "../../scheduler-host/scheduler-admission.ts";
import { DAEMON_LIVENESS, inspectDaemon } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import {
  inspectSchedulerServiceState,
  schedulerServiceStatePath,
  SCHEDULER_SERVICE_STATE_PHASES,
} from "../../scheduler-host/service-state.ts";
import {
  SCHEDULER_UPDATE_RECONCILE_OUTCOMES,
  reconcileSchedulerServiceAfterUpdate,
  type SchedulerServiceRestartRun,
} from "./update-scheduler-service.ts";

type InstallConfig = RollConfig["install"];

/** install 配置 → npm install 网络韧性参数。 */
function buildInstallNetworkArgs(install: InstallConfig): string[] {
  return npmInstallNetworkArgs({
    ...(install.registry ? { registry: install.registry } : {}),
    fetchRetries: install.fetchRetries,
    preferOffline: install.preferOffline,
  });
}

/** install 配置 → 版本检查（npm view）的查询选项。 */
function buildVersionQueryOptions(install: InstallConfig): {
  forceRefresh: true;
  fetchRetries: number;
  registry?: string;
} {
  return {
    forceRefresh: true,
    fetchRetries: install.fetchRetries,
    ...(install.registry ? { registry: install.registry } : {}),
  };
}

function isUnreadableConfigInspection(inspection: ConfigInspectionResult): boolean {
  if (inspection.status !== "invalid") {
    return false;
  }
  return (
    inspection.error.message.startsWith("Invalid YAML syntax") ||
    inspection.error.message.includes("(expected YAML object)")
  );
}

function loadStrictAgentStore(
  dataDir: string,
  registryLock?: AgentRegistryLock,
): { readonly store: AgentStore; readonly agents: readonly RegisteredAgent[] } {
  const store = new AgentStore(dataDir, {
    ...(registryLock ? { registryLock } : {}),
  });
  const agents = store.list();
  const storedEntryCount = readAgentStoreEntryCount(dataDir);
  if (agents.length !== storedEntryCount) {
    throw new Error(
      `Agent 注册表包含 ${String(storedEntryCount - agents.length)} 条无法解析的记录`,
    );
  }
  return { store, agents };
}

const execFileAsync = promisify(execFile);

export { inferAgentSourceType as inferSourceType } from "../../registry/source.ts";
export { detectInstallCommand } from "../utils/package-manager.ts";
export { discoverUpdatedAgent } from "../../registry/installed-package-update.ts";

function logConfigInspectionNotice(
  inspection: ConfigInspectionResult,
  mode: "check" | "pre-update" | "post-update",
): void {
  switch (inspection.status) {
    case "needs-migration": {
      const title = mode === "post-update" ? "升级后需要迁移本地配置" : "检测到本地配置需要迁移";
      log.warn(`${title}: ${inspection.configPath}`);
      for (const issue of inspection.report.issues) {
        log.warn(`  - ${issue.message}`);
      }
      if (inspection.report.canAutoMigrate) {
        log.info("建议命令: roll config migrate");
      }
      break;
    }
    case "invalid": {
      log.warn(`本地配置存在问题: ${inspection.configPath ?? "(unknown path)"}`);
      log.warn(`  - ${inspection.error.message}`);
      if (mode === "post-update") {
        log.info("请修复配置文件后再继续使用相关命令。");
      }
      break;
    }
    default:
      break;
  }
}

interface AgentCheckSummary {
  readonly name: string;
  readonly sourceType: AgentSourceType;
  readonly icon: string;
  readonly action: string;
}

function getInstalledPackageCheckIcon(status: PublishedPackageUpdateStatus): string {
  switch (status) {
    case "up-to-date":
      return "✅";
    case "update-available":
      return "⬆";
    case "pinned-behind":
      return "📌";
    case "unsupported-spec":
      return "?";
    case "unknown":
      return "?";
  }
}

function formatInstalledPackageCheckAction(
  info: PublishedPackageUpdateInfo,
  packageSpec: string,
): string {
  switch (info.status) {
    case "up-to-date":
      return info.currentVersion ? `已是最新版本 (v${info.currentVersion})` : "已是最新版本";
    case "update-available":
      if (info.currentVersion && info.latestVersion) {
        return `可更新 v${info.currentVersion} → v${info.latestVersion}`;
      }
      return "检测到可用更新";
    case "pinned-behind":
      if (info.currentVersion && info.latestVersion) {
        return `固定版本 v${info.currentVersion}；latest=v${info.latestVersion}`;
      }
      return "固定版本，需手动调整 package spec";
    case "unsupported-spec":
      return `不支持检查此 package spec: ${packageSpec}`;
    case "unknown":
      if (info.currentVersion) {
        return `无法检查最新版本 (current=v${info.currentVersion})`;
      }
      return "无法检查最新版本";
  }
}

function hydrateInstalledPackageAgent(agent: RegisteredAgent, store?: AgentStore): RegisteredAgent {
  if (agent.source?.type !== "installed-package") {
    return agent;
  }

  const packageRoot = resolveInstalledPackageRoot(
    agent.source.installDir,
    agent.source.packageName,
  );
  const manifest = readInstalledPackageManifest(packageRoot);
  if (!manifest) {
    return agent;
  }

  const nextSource = {
    ...agent.source,
    ...(manifest.name ? { packageName: manifest.name } : {}),
    ...(manifest.version ? { installedVersion: manifest.version } : {}),
  };
  const sourceChanged =
    nextSource.packageName !== agent.source.packageName ||
    nextSource.installedVersion !== agent.source.installedVersion;
  const installPathChanged = packageRoot !== agent.installPath;

  if (!sourceChanged && !installPathChanged) {
    return agent;
  }

  const nextAgent: RegisteredAgent = {
    ...agent,
    installPath: packageRoot,
    source: nextSource,
  };
  if (store) {
    store.replace(agent.skill.name, nextAgent);
  }
  return nextAgent;
}

function getInstalledPackageUpdateSpec(agent: RegisteredAgent): string | undefined {
  if (agent.source?.type !== "installed-package") {
    return undefined;
  }

  const { packageName, packageSpec } = agent.source;

  // Floating npm specs can reuse an old saved dependency range inside --prefix, e.g. ^0.15.0.
  // The update checker compares floating registry specs against latest, so install latest explicitly.
  if (
    packageSpec === packageName ||
    (packageSpec.startsWith(`${packageName}@`) &&
      !isPinnedPublishedPackageSpec(packageName, packageSpec))
  ) {
    return `${packageName}@latest`;
  }

  return packageSpec;
}

/** 更新 roll-core 自身 */
async function updateSelf(
  latest: string,
  dryRun: boolean,
  install: InstallConfig,
  target: Extract<SelfUpdateTarget, { channel: "npm" }>,
): Promise<boolean> {
  const current = getCurrentVersion();
  if (current === latest) {
    log.info(`roll 已是最新版本 (v${current})`);
    return false;
  }

  log.info(`roll v${current} → v${latest}`);
  if (dryRun) {
    log.info("[dry-run] 跳过实际更新");
    return true;
  }

  const spinner = createSpinner("正在更新 @roll-agent/core...").start();
  const installSpec: PackageManagerRunSpec = {
    command: "npm",
    args: [
      "install",
      "-g",
      "--prefix",
      target.prefix,
      `@roll-agent/core@${latest}`,
      ...buildInstallNetworkArgs(install),
    ],
  };
  try {
    await runPackageManagerWithRetry(
      installSpec,
      { timeout: install.networkTimeoutMs },
      {
        ...buildNpmRetryPolicy(install.fetchRetries),
        onRetry: ({ attempt, delayMs }) => {
          spinner.text = `roll 更新遇到网络问题，${Math.round(delayMs / 1000)}s 后重试（第 ${attempt + 1} 次）...`;
        },
      },
    );
    spinner.succeed(`roll 已更新到 v${latest}`);
    return true;
  } catch (err) {
    spinner.fail("更新失败");
    log.error(formatPackageManagerError(installSpec, err));
    return false;
  }
}

/** 更新 git 来源的 Agent */
async function updateGitAgent(agent: RegisteredAgent): Promise<boolean> {
  const spinner = createSpinner(`更新 ${agent.skill.name} (git pull)...`).start();
  try {
    await execFileAsync("git", ["pull"], { cwd: agent.installPath, timeout: 30_000 });
    spinner.succeed(`${agent.skill.name} 代码已更新`);

    // 重新安装依赖
    const packageJsonPath = resolve(agent.installPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const installCommand = detectInstallCommand(agent.installPath);
      if (!installCommand) {
        log.warn(`${agent.skill.name} 未检测到 packageManager 或 lockfile，跳过依赖安装。`);
      } else {
        const depSpinner = createSpinner(`安装 ${agent.skill.name} 依赖...`).start();
        try {
          await runPackageManager(installCommand, {
            cwd: agent.installPath,
            timeout: 60_000,
          });
          depSpinner.succeed(
            `${agent.skill.name} 依赖已更新 (${installCommand.command} ${installCommand.args.join(" ")})`,
          );
        } catch (err) {
          depSpinner.fail(`${agent.skill.name} 依赖安装失败`);
          log.error(formatPackageManagerError(installCommand, err));
          return false;
        }
      }
    }

    return true;
  } catch (err) {
    spinner.fail(`${agent.skill.name} 更新失败`);
    log.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** 刷新远程 Agent 的 MCP 元数据 */
async function refreshRemoteAgent(agent: RegisteredAgent): Promise<boolean> {
  const spinner = createSpinner(`刷新 ${agent.skill.name} (MCP tools/list)...`).start();
  const manager = new McpClientManager();
  try {
    const transport = resolveTransportWithDevSpawnSpec(agent);
    const client = await manager.connect(agent.skill.name, transport, agent.installPath);
    const { tools } = await client.listTools();
    spinner.succeed(`${agent.skill.name} 元数据已刷新（${tools.length} 个 tool）`);
    return true;
  } catch (err) {
    spinner.fail(`${agent.skill.name} 刷新失败`);
    log.error(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    await manager.disconnectAll();
  }
}

interface UpdateManagedRuntimeBaseline {
  readonly agent: RegisteredAgent;
  readonly guard: AgentUsageMaintenanceGuard;
  readonly retention: ManagedAgentRuntimeRetention;
}

async function acquireUpdateMaintenanceGuards(
  agents: readonly RegisteredAgent[],
  dataDir: string,
): Promise<readonly AgentUsageMaintenanceGuard[]> {
  const guards: AgentUsageMaintenanceGuard[] = [];
  try {
    for (const agent of [...agents].sort((left, right) =>
      left.skill.name.localeCompare(right.skill.name),
    )) {
      const guard = await acquireAgentUsageMaintenanceGuard(agent, dataDir);
      if (guard !== undefined) guards.push(guard);
    }
    return guards;
  } catch (error) {
    for (const guard of guards.reverse()) guard.release();
    throw error;
  }
}

async function stopManagedAgentsForUpdate(
  agents: readonly RegisteredAgent[],
  guards: readonly AgentUsageMaintenanceGuard[],
  dataDir: string,
): Promise<ReadonlyMap<string, UpdateManagedRuntimeBaseline>> {
  const agentByName = new Map(agents.map((agent) => [agent.skill.name, agent]));
  const baselines = new Map<string, UpdateManagedRuntimeBaseline>();
  try {
    for (const guard of guards) {
      const runtime = guard.runtime;
      if (runtime === undefined) continue;
      const agent = agentByName.get(guard.agentName);
      if (agent === undefined) continue;

      baselines.set(guard.agentName, {
        agent,
        guard,
        retention: runtime.retention,
      });
      const stopped = await stopAgentGracefully(dataDir, guard.agentName, {
        expectedIdentity: runtime.identity,
        lifecycleLock: guard.lifecycleLock,
      });
      if (!stopped) {
        throw new Error(`Agent "${guard.agentName}" 在更新前已发生运行时变化，拒绝继续更新。`);
      }
    }
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const baseline of baselines.values()) {
      if (baseline.retention !== MANAGED_AGENT_RUNTIME_RETENTIONS.persistent) continue;
      try {
        if (readVerifiedManagedAgentRuntime(dataDir, baseline.agent.skill.name) !== undefined) {
          continue;
        }
        await startManagedAgentAndWait(baseline.agent, dataDir, baseline.guard);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        "更新前停止 Agent 失败，且部分 persistent Agent 未能恢复。",
      );
    }
    throw error;
  }
  return baselines;
}

function releaseUpdateMaintenanceGuards(guards: readonly AgentUsageMaintenanceGuard[]): void {
  for (const guard of [...guards].reverse()) guard.release();
}

async function restorePersistentManagedAgents(
  baselines: ReadonlyMap<string, UpdateManagedRuntimeBaseline>,
  store: AgentStore,
  dataDir: string,
  warn: (message: string) => void = log.warn,
): Promise<number> {
  let failures = 0;
  for (const baseline of baselines.values()) {
    if (baseline.retention !== MANAGED_AGENT_RUNTIME_RETENTIONS.persistent) {
      continue;
    }
    try {
      if (readVerifiedManagedAgentRuntime(dataDir, baseline.agent.skill.name) !== undefined) {
        store.updateStatus(baseline.agent.skill.name, "online");
        continue;
      }
    } catch (error) {
      warn(
        `${baseline.agent.skill.name} 恢复前发现不可验证 runtime：${error instanceof Error ? error.message : String(error)}`,
      );
      failures += 1;
      continue;
    }

    const currentAgent = store.findByName(baseline.agent.skill.name) ?? baseline.agent;
    if (currentAgent.runtime.ownership !== "core-managed") {
      warn(`${baseline.agent.skill.name} 更新后不再是 core-managed，未恢复旧常驻进程。`);
      continue;
    }
    try {
      await startManagedAgentAndWait(currentAgent, dataDir, baseline.guard);
      store.updateStatus(currentAgent.skill.name, "online");
    } catch (error) {
      store.updateStatus(currentAgent.skill.name, "error");
      warn(
        `${currentAgent.skill.name} 更新失败后的常驻恢复也失败：${error instanceof Error ? error.message : String(error)}`,
      );
      failures += 1;
    }
  }
  return failures;
}

/** Called under scheduler admission: existing work must settle before any Agent is stopped. */
async function assertInstallerSchedulerIdle(config: RollConfig): Promise<void> {
  const inspection = inspectSchedulerServiceState(schedulerServiceStatePath());
  if (inspection.status === "invalid") {
    throw new Error(`无法验证 scheduler service metadata，拒绝激活：${inspection.error}`);
  }
  if (
    inspection.status === "valid" &&
    inspection.state.phase !== SCHEDULER_SERVICE_STATE_PHASES.installed
  ) {
    throw new Error("scheduler service 正在安装或恢复，拒绝激活 Roll 新版本。");
  }
  const installedDataDir = inspection.status === "valid" ? inspection.state.dataDir : undefined;
  const dataDirs = new Set([
    resolve(config.scheduler.dataDir),
    ...(installedDataDir === undefined ? [] : [resolve(installedDataDir)]),
  ]);
  for (const dataDir of dataDirs) {
    const paths = createSchedulerPaths(dataDir);
    const daemon = inspectDaemon(paths.daemonRecordPath);
    if (
      (existsSync(paths.daemonRecordPath) && daemon.record === undefined) ||
      daemon.liveness === DAEMON_LIVENESS.unverifiable
    ) {
      throw new Error("无法验证 scheduler daemon 身份，拒绝激活 Roll 新版本。");
    }
    if (!existsSync(resolve(dataDir, "schedules.db"))) {
      if (dataDir === installedDataDir || daemon.liveness === DAEMON_LIVENESS.running) {
        throw new Error("scheduler service/daemon 的任务账本缺失，拒绝激活 Roll 新版本。");
      }
      continue;
    }
    const runtime = await import("@roll-agent/runtime");
    if (runtime.readScheduleLedger(dataDir).status === "migration-required") {
      throw new Error("scheduler 任务账本需要迁移，安装器不会迁移用户数据库，拒绝激活。");
    }
    const utils = await loadScheduleServiceUtils();
    const blockers = await utils.listSchedulerServiceBlockerIds(dataDir);
    if (blockers.length > 0) {
      throw new Error(
        `scheduler 仍有 ${blockers.length} 个活跃或尚未确认结束的任务，拒绝激活：${utils.describeSchedulerServiceBlockers(blockers)}`,
      );
    }
  }
}

/**
 * Activate an already verified installer payload without updating any Agent package. The caller
 * owns the distribution lock and disposal; this boundary owns runtime admission and recovery.
 */
export async function activateInstallerDistribution(
  current: ExecutionEnvironment,
  prepared: PreparedDistribution,
): Promise<{ readonly environment: ExecutionEnvironment; readonly warnings: readonly string[] }> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };
  let environment = current;
  await withExecutionEnvironment(current, async () => {
    // Unlike the interactive updater's explicit skip mode, an installer must never activate
    // while an unreadable configuration could conceal an Agent data directory or ownership.
    const { config } = loadConfig();
    const { agentsConfig } = loadAgentsConfig();
    let admission: AgentLifecycleLock | undefined;
    let registry: AgentRegistryLock | undefined;
    let guards: readonly AgentUsageMaintenanceGuard[] = [];
    let baselines: ReadonlyMap<string, UpdateManagedRuntimeBaseline> = new Map();
    let failure: unknown;
    let failed = false;
    const releaseErrors: unknown[] = [];
    try {
      admission = await acquireSchedulerAdmissionLockWithRetry();
      await assertInstallerSchedulerIdle(config);
      registry = await acquireAgentRegistryLockAsync(agentsConfig.dataDir);
      const loaded = loadStrictAgentStore(agentsConfig.dataDir, registry);
      const store = loaded.store;
      const agents = loaded.agents.map((agent) =>
        inferAgentSourceType(agent) === "installed-package"
          ? hydrateInstalledPackageAgent(agent)
          : agent,
      );
      guards = await acquireUpdateMaintenanceGuards(agents, agentsConfig.dataDir);
      baselines = await stopManagedAgentsForUpdate(agents, guards, agentsConfig.dataDir);
      try {
        environment = await prepared.activate();
      } catch (error) {
        const failures = await restorePersistentManagedAgents(
          baselines,
          store,
          agentsConfig.dataDir,
          warn,
        );
        if (failures > 0) {
          throw new AggregateError(
            [error],
            `激活失败，且 ${failures} 个常驻 Agent 未能恢复：${warnings.join("；")}`,
          );
        }
        throw error;
      }
      // The old process.execPath must not choose the interpreter for restored runtimes.
      await withExecutionEnvironment(environment, async () => {
        try {
          const failures = await restorePersistentManagedAgents(
            baselines,
            store,
            agentsConfig.dataDir,
            warn,
          );
          if (failures > 0) warn(`${failures} 个常驻 Agent 恢复失败；Roll 新版本已激活。`);
        } catch (error) {
          warn(
            `Roll 新版本已激活，但常驻 Agent 恢复失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      for (const lock of [...guards].reverse()) {
        try {
          lock.release();
        } catch (error) {
          releaseErrors.push(error);
        }
      }
      for (const lock of [registry, admission]) {
        try {
          lock?.release();
        } catch (error) {
          releaseErrors.push(error);
        }
      }
    }
    if (failed) {
      if (releaseErrors.length > 0) {
        throw new AggregateError([failure, ...releaseErrors], "安装失败，且部分维护锁未能释放");
      }
      throw failure;
    }
    if (releaseErrors.length > 0) {
      warn("Roll 新版本已激活，但部分维护锁未能释放；请检查 Agent 和 scheduler 状态。");
    }
  });
  try {
    await withExecutionEnvironment(environment, async () => {
      if (process.platform !== "darwin" && process.platform !== "win32") return;
      const result = await reconcileSchedulerServiceAfterUpdate(
        runSchedulerServiceRestartInFreshProcess,
      );
      if (result.outcome === SCHEDULER_UPDATE_RECONCILE_OUTCOMES.deferred) {
        warn(`roll schedule daemon 用户服务仍在运行旧版本：${result.reason}`);
      } else if (result.outcome === SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed) {
        warn(
          `roll schedule daemon 用户服务自动重启失败：${result.error}；请手动执行 roll schedule service restart`,
        );
      }
      await reportCompanionServiceAfterUpdate(warn);
    });
  } catch (error) {
    warn(
      `Roll 新版本已激活，但后台服务协调失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { environment, warnings };
}

export default defineCommand({
  meta: { description: "检查并更新 roll 及已注册 Agent" },
  args: {
    check: {
      type: "boolean",
      description: "仅检查 roll/Agent 可用更新，不执行安装或刷新",
      default: false,
    },
    "skip-browser-setup": {
      type: "boolean",
      description: "跳过 Playwright 浏览器运行时安装/校验",
      default: false,
    },
  },
  async run({ args }) {
    const isCheckOnly = args.check;
    let executionEnvironment = getExecutionEnvironment();
    const selfUpdateTarget = await resolveSelfUpdateTarget(executionEnvironment);
    const configInspection = inspectConfigFile();

    let installConfig: InstallConfig;
    try {
      installConfig = loadInstallConfig().installConfig;
    } catch (error) {
      if (isUnreadableConfigInspection(configInspection)) {
        installConfig = DEFAULT_CONFIG.install;
        log.warn(
          `无法读取 install 配置，使用默认值：${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        log.error(
          `install 配置无效，已停止更新：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
      }
    }
    if (installConfig.registry) {
      log.info(`使用 npm registry: ${installConfig.registry}（roll.config.yaml install.registry）`);
    }
    const versionQuery = buildVersionQueryOptions(installConfig);

    // === 1. 检查 roll-core 自身 ===
    log.info("检查 roll 更新...");
    const info = await checkForUpdate(versionQuery);

    if (selfUpdateTarget.channel === "unmanaged") {
      log.info(selfUpdateTarget.reason);
    } else if (info.unavailable) {
      log.warn("暂时无法检查 roll 更新，本体更新已跳过；当前版本继续可用。");
    } else if (info.hasUpdate) {
      log.success(`roll 有新版本: v${info.current} → v${info.latest}`);
    } else {
      log.info(`roll 已是最新版本 (v${info.current})`);
    }
    if (isCheckOnly) {
      await reportSchedulerServiceBinaryDrift();
    }

    // === 2. 检查已注册 Agent ===
    let agentsConfig: ReturnType<typeof loadAgentsConfig>["agentsConfig"] | undefined;
    let store: AgentStore | undefined;
    let agents: readonly RegisteredAgent[] = [];

    try {
      agentsConfig = loadAgentsConfig().agentsConfig;
      ({ store, agents } = loadStrictAgentStore(agentsConfig.dataDir));
    } catch (err) {
      agentsConfig = undefined;
      store = undefined;
      agents = [];
      log.warn(
        `无法读取 Agent 配置，跳过已注册 Agent 检查：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    agents = agents.map((agent) =>
      inferAgentSourceType(agent) === "installed-package"
        ? hydrateInstalledPackageAgent(agent)
        : agent,
    );
    const agentSummary: AgentCheckSummary[] = [];

    for (const agent of agents) {
      const sourceType = inferAgentSourceType(agent);
      switch (sourceType) {
        case "git":
          agentSummary.push({
            name: agent.skill.name,
            sourceType,
            icon: "~",
            action: "可执行 git pull + 重新安装依赖",
          });
          break;
        case "installed-package": {
          if (agent.source?.type !== "installed-package") {
            agentSummary.push({
              name: agent.skill.name,
              sourceType,
              icon: "?",
              action: "无法检查已安装包版本",
            });
            break;
          }
          const info = await checkPublishedPackageUpdate(
            {
              packageName: agent.source.packageName,
              packageSpec: agent.source.packageSpec,
              ...(agent.source.installedVersion
                ? { currentVersion: agent.source.installedVersion }
                : {}),
            },
            versionQuery,
          );
          agentSummary.push({
            name: agent.skill.name,
            sourceType,
            icon: getInstalledPackageCheckIcon(info.status),
            action: formatInstalledPackageCheckAction(info, agent.source.packageSpec),
          });
          break;
        }
        case "remote-manifest":
          agentSummary.push({
            name: agent.skill.name,
            sourceType,
            icon: "~",
            action: "可刷新本地 manifest + MCP 元数据",
          });
          break;
        case "local-path":
          agentSummary.push({
            name: agent.skill.name,
            sourceType,
            icon: "⏭",
            action: "刷新本地 SKILL/manifest",
          });
          break;
      }
    }

    if (agents.length > 0) {
      log.info(`\n已注册 Agent (${agents.length}):`);
      for (const s of agentSummary) {
        log.info(`  ${s.icon} ${s.name} [${s.sourceType}] — ${s.action}`);
      }
    } else if (agentsConfig) {
      log.info("无已注册 Agent");
    }

    if (configInspection.status === "needs-migration" || configInspection.status === "invalid") {
      log.info("");
      logConfigInspectionNotice(configInspection, isCheckOnly ? "check" : "pre-update");
    }

    // --check 模式到此结束
    if (isCheckOnly) return;

    // === 3. 执行更新 ===
    log.info("");
    let preparedDistribution: PreparedDistribution | undefined;
    if (selfUpdateTarget.channel === "standalone" && info.hasUpdate) {
      const spinner = createSpinner(`下载并验证 Roll v${info.latest}...`).start();
      try {
        const manifest = await fetchDistributionManifest({
          version: info.latest,
          timeoutMs: installConfig.networkTimeoutMs,
        });
        preparedDistribution = await prepareDistributionUpdate(executionEnvironment, manifest, {
          timeoutMs: installConfig.networkTimeoutMs,
        });
        spinner.succeed(`Roll v${info.latest} 已验证，准备进入更新维护阶段`);
      } catch (error) {
        spinner.fail("独立发行包下载或验证失败，当前版本与 Agent 保持原状");
        log.error(error instanceof Error ? error.message : String(error));
        process.exitCode = error instanceof DistributionUpdateInterruptedError ? error.exitCode : 1;
        return;
      }
    }
    let registryLock: AgentRegistryLock | undefined;
    let maintenanceGuards: readonly AgentUsageMaintenanceGuard[] = [];
    let managedRuntimeBaselines = new Map<string, UpdateManagedRuntimeBaseline>();
    let schedulerAdmissionLock: AgentLifecycleLock | undefined;
    try {
      schedulerAdmissionLock = await acquireSchedulerAdmissionLockWithRetry();
    } catch (error) {
      await preparedDistribution?.dispose();
      log.error(
        `更新前无法暂停 scheduler 领取新任务，尚未修改软件包：${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      return;
    }
    if (agentsConfig !== undefined && store !== undefined) {
      try {
        registryLock = await acquireAgentRegistryLockAsync(agentsConfig.dataDir);
        ({ store, agents } = loadStrictAgentStore(agentsConfig.dataDir, registryLock));
        agents = agents.map((agent) =>
          inferAgentSourceType(agent) === "installed-package"
            ? hydrateInstalledPackageAgent(agent)
            : agent,
        );
        maintenanceGuards = await acquireUpdateMaintenanceGuards(agents, agentsConfig.dataDir);
        managedRuntimeBaselines = new Map(
          await stopManagedAgentsForUpdate(agents, maintenanceGuards, agentsConfig.dataDir),
        );
      } catch (error) {
        await preparedDistribution?.dispose();
        releaseUpdateMaintenanceGuards(maintenanceGuards);
        registryLock?.release();
        schedulerAdmissionLock?.release();
        schedulerAdmissionLock = undefined;
        log.error(
          `更新前 Agent 使用状态检查失败，尚未修改软件包或注册数据：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
      }
    }

    let selfUpdated = false;
    try {
      // 3a. 更新 roll-core
      let selfUpdateFailed = false;
      if (info.hasUpdate && selfUpdateTarget.channel !== "unmanaged") {
        if (preparedDistribution) {
          executionEnvironment = await preparedDistribution.activate();
          selfUpdated = true;
          log.success(`roll 已更新到 v${info.latest}`);
        } else if (selfUpdateTarget.channel === "npm") {
          selfUpdated = await updateSelf(info.latest, false, installConfig, selfUpdateTarget);
          if (!selfUpdated) selfUpdateFailed = true;
        }
      }

      await withExecutionEnvironment(executionEnvironment, async () => {
        if (
          selfUpdated &&
          (configInspection.status === "needs-migration" || configInspection.status === "invalid")
        ) {
          log.info("");
          logConfigInspectionNotice(configInspection, "post-update");
        }
        if (agentsConfig === undefined || store === undefined) {
          log.warn("无法可靠读取 Agent 注册表，已跳过已注册 Agent 更新。");
        }

        // 3b. 更新 Agent
        let updatedCount = 0;
        let failedCount = 0;

        for (const agent of agents) {
          if (!store || !agentsConfig) {
            break;
          }
          const sourceType = inferAgentSourceType(agent);
          const managedBaseline = managedRuntimeBaselines.get(agent.skill.name);
          const wasRunning =
            managedBaseline !== undefined ||
            (agent.runtime.ownership === "core-managed" &&
              getAgentPid(agentsConfig.dataDir, agent.skill.name) !== undefined);
          const shouldRestart =
            managedBaseline === undefined
              ? wasRunning
              : managedBaseline.retention === MANAGED_AGENT_RUNTIME_RETENTIONS.persistent;

          switch (sourceType) {
            case "git": {
              const ok = await updateGitAgent(agent);
              if (ok) {
                // 重新解析 SKILL.md 并更新 store
                try {
                  const discovered = discoverUpdatedAgent(agent, agent.installPath);
                  const updated: RegisteredAgent = {
                    ...agent,
                    skill: discovered.skill,
                    transport: discovered.transport,
                    runtime: discovered.runtime,
                    ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
                  };
                  const replaced = store.replace(agent.skill.name, updated);
                  if (!replaced) {
                    log.warn(`${agent.skill.name} 已从注册表中移除，跳过元数据刷新`);
                    failedCount++;
                  } else {
                    await maybeRestartManagedAgent(
                      updated,
                      wasRunning,
                      shouldRestart,
                      agentsConfig.dataDir,
                      managedBaseline?.guard,
                    );
                    updatedCount++;
                  }
                } catch (err) {
                  managedRuntimeBaselines.delete(agent.skill.name);
                  store.updateStatus(agent.skill.name, "error");
                  log.warn(
                    `${agent.skill.name} metadata 刷新或重启失败，未自动恢复常驻进程: ${err instanceof Error ? err.message : String(err)}`,
                  );
                  failedCount++;
                }
              } else {
                managedRuntimeBaselines.delete(agent.skill.name);
                store.updateStatus(agent.skill.name, "error");
                log.warn(
                  `${agent.skill.name} 的 Git 工作目录可能已部分更新，已保持停止状态；请检查目录后手动执行 \`roll agent start ${agent.skill.name}\`。`,
                );
                failedCount++;
              }
              break;
            }
            case "installed-package": {
              if (wasRunning && managedBaseline === undefined) {
                try {
                  await stopAgentGracefully(agentsConfig.dataDir, agent.skill.name);
                } catch (err) {
                  store.updateStatus(agent.skill.name, "error");
                  log.warn(
                    `${agent.skill.name} 停止失败，无法继续升级: ${err instanceof Error ? err.message : String(err)}`,
                  );
                  failedCount++;
                  break;
                }
              }

              let updateSpinner: ReturnType<typeof createSpinner> | undefined;
              const reportInstalledPackageUpdate = (event: InstalledPackageUpdateEvent): void => {
                switch (event.type) {
                  case "install-start":
                    updateSpinner = createSpinner(
                      `更新 ${event.agentName} (npm install)...`,
                    ).start();
                    break;
                  case "install-retry":
                    if (updateSpinner !== undefined) {
                      updateSpinner.text =
                        `更新 ${event.agentName} 遇到网络问题，` +
                        `${Math.round(event.delayMs / 1000)}s 后重试` +
                        `（第 ${event.attempt + 1} 次）...`;
                    }
                    break;
                  case "install-succeeded":
                    updateSpinner?.succeed(`${event.agentName} 已重新安装`);
                    break;
                  case "install-failed":
                    updateSpinner?.fail(`${event.agentName} 更新失败`);
                    break;
                }
              };
              const stoppedPersistentAgent =
                managedBaseline?.retention === MANAGED_AGENT_RUNTIME_RETENTIONS.persistent
                  ? managedBaseline.agent
                  : undefined;
              const updateResult = await updateInstalledPackage({
                agent,
                install: installConfig,
                store,
                shouldRestart,
                resolvePackageSpec: getInstalledPackageUpdateSpec,
                ...(args["skip-browser-setup"] !== undefined
                  ? { skipBrowserSetup: args["skip-browser-setup"] }
                  : {}),
                ...(stoppedPersistentAgent !== undefined ? { stoppedPersistentAgent } : {}),
                ...(shouldRestart
                  ? {
                      restartUpdatedAgent: (updated) =>
                        startManagedAgentAndWait(
                          updated,
                          agentsConfig.dataDir,
                          managedBaseline?.guard,
                        ),
                    }
                  : {}),
                report: reportInstalledPackageUpdate,
              });
              if (updateResult.ok) {
                if (
                  updateResult.commit.kind ===
                  INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.cleanupFailed
                ) {
                  const backupPath = getInstallDirectoryBackupPath(updateResult.commit.backup);
                  log.warn(
                    `${updateResult.agent.skill.name} 已更新，但旧安装目录副本清理失败：` +
                      `${updateResult.commit.error instanceof Error ? updateResult.commit.error.message : String(updateResult.commit.error)}` +
                      `；请检查 ${backupPath ?? updateResult.commit.backup.installDir}`,
                  );
                }
                updatedCount++;
              } else {
                if (updateResult.retryCommand !== undefined) {
                  log.info(`重试命令: ${updateResult.retryCommand}`);
                }
                for (const failure of updateResult.rollback.kind === "partial"
                  ? updateResult.rollback.failures
                  : []) {
                  if (failure.step === INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS.registration) {
                    log.warn(
                      `${agent.skill.name} 注册表回滚失败：${
                        failure.error instanceof Error
                          ? failure.error.message
                          : String(failure.error)
                      }`,
                    );
                    continue;
                  }
                  const backupPath = getInstallDirectoryBackupPath(failure.backup);
                  const message =
                    `${agent.skill.name} 安装目录回滚失败：${
                      failure.error instanceof Error ? failure.error.message : String(failure.error)
                    }` +
                    (backupPath === undefined
                      ? `；请检查未清理的新安装目录 ${failure.backup.installDir}`
                      : `；回滚副本保留在 ${backupPath}`);
                  if (updateResult.phase === INSTALLED_PACKAGE_UPDATE_PHASES.install) {
                    log.error(message);
                  } else {
                    log.warn(message);
                  }
                }
                const runtimeRecoveryBlocked =
                  updateResult.rollback.runtimeRecovery.kind ===
                  INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.blocked;
                if (runtimeRecoveryBlocked) {
                  managedRuntimeBaselines.delete(agent.skill.name);
                }
                store.updateStatus(agent.skill.name, "error");
                if (updateResult.phase === INSTALLED_PACKAGE_UPDATE_PHASES.install) {
                  log.error(updateResult.message);
                } else {
                  log.warn(
                    `${agent.skill.name} metadata 刷新、setup 或重启失败${
                      runtimeRecoveryBlocked ? "，未自动恢复常驻进程" : "，已恢复更新前安装目录状态"
                    }: ${updateResult.message}`,
                  );
                }
                failedCount++;
              }
              break;
            }
            case "remote-manifest": {
              try {
                const discovered = discoverUpdatedAgent(agent, agent.installPath);
                const updated: RegisteredAgent = {
                  ...agent,
                  skill: discovered.skill,
                  transport: discovered.transport,
                  runtime: discovered.runtime,
                  ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
                };
                const replaced = store.replace(agent.skill.name, updated);
                if (!replaced) {
                  log.warn(`${agent.skill.name} 已从注册表中移除，跳过元数据刷新`);
                  failedCount++;
                  break;
                }
                const ok = await refreshRemoteAgent(updated);
                if (ok) {
                  updatedCount++;
                } else {
                  failedCount++;
                }
              } catch (err) {
                const nameChanged = err instanceof AgentUpdateNameChangedError;
                if (nameChanged) {
                  managedRuntimeBaselines.delete(agent.skill.name);
                }
                log.warn(
                  `${agent.skill.name} manifest 刷新失败${
                    nameChanged ? "，未自动恢复常驻进程" : ""
                  }: ${err instanceof Error ? err.message : String(err)}`,
                );
                failedCount++;
              }
              break;
            }
            case "local-path": {
              try {
                const discovered = discoverUpdatedAgent(agent, agent.installPath);
                const updated: RegisteredAgent = {
                  ...agent,
                  skill: discovered.skill,
                  transport: discovered.transport,
                  runtime: discovered.runtime,
                  ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
                };
                const replaced = store.replace(agent.skill.name, updated);
                if (!replaced) {
                  log.warn(`${agent.skill.name} 已从注册表中移除，跳过元数据刷新`);
                  failedCount++;
                } else {
                  await maybeRestartManagedAgent(
                    updated,
                    wasRunning,
                    shouldRestart,
                    agentsConfig.dataDir,
                    managedBaseline?.guard,
                  );
                  updatedCount++;
                }
              } catch (err) {
                const nameChanged = err instanceof AgentUpdateNameChangedError;
                if (nameChanged) {
                  managedRuntimeBaselines.delete(agent.skill.name);
                }
                store.updateStatus(agent.skill.name, "error");
                log.warn(
                  `${agent.skill.name} 本地 metadata 刷新或重启失败${
                    nameChanged ? "，未自动恢复常驻进程" : ""
                  }: ${err instanceof Error ? err.message : String(err)}`,
                );
                failedCount++;
              }
              break;
            }
          }
        }

        if (store !== undefined && agentsConfig !== undefined) {
          failedCount += await restorePersistentManagedAgents(
            managedRuntimeBaselines,
            store,
            agentsConfig.dataDir,
          );
        }

        releaseUpdateMaintenanceGuards(maintenanceGuards);
        maintenanceGuards = [];
        registryLock?.release();
        registryLock = undefined;
        schedulerAdmissionLock?.release();
        schedulerAdmissionLock = undefined;

        let schedulerReconcileFailed = false;
        if (selfUpdated && (process.platform === "darwin" || process.platform === "win32")) {
          const schedulerResult = await reconcileSchedulerServiceAfterUpdate(
            runSchedulerServiceRestartInFreshProcess,
          );
          switch (schedulerResult.outcome) {
            case SCHEDULER_UPDATE_RECONCILE_OUTCOMES.restarted:
              log.success("roll schedule daemon 用户服务已按新版本重装并重启。");
              break;
            case SCHEDULER_UPDATE_RECONCILE_OUTCOMES.deferred:
              log.warn(`roll schedule daemon 用户服务仍在运行旧版本：${schedulerResult.reason}`);
              break;
            case SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed:
              schedulerReconcileFailed = true;
              log.warn(
                `roll schedule daemon 用户服务自动重启失败：${schedulerResult.error}；请手动执行 roll schedule service restart`,
              );
              break;
            case SCHEDULER_UPDATE_RECONCILE_OUTCOMES.notInstalled:
              break;
          }
          await reportCompanionServiceAfterUpdate();
        }

        // === 4. 总结 ===
        log.info("");
        const totalFailed =
          failedCount + (selfUpdateFailed ? 1 : 0) + (schedulerReconcileFailed ? 1 : 0);
        const rollStatus = selfUpdateFailed
          ? "roll 更新失败"
          : selfUpdated
            ? "roll ✓"
            : info.unavailable
              ? "roll 本体更新已跳过（版本检查不可用）"
              : "roll 无更新";
        if (totalFailed > 0) {
          process.exitCode = 1;
          log.warn(
            `更新完成但有失败：${rollStatus}${
              failedCount > 0 ? `，${failedCount} 个 Agent 更新失败` : ""
            }${schedulerReconcileFailed ? "，scheduler service 重启失败" : ""}${updatedCount > 0 ? `，${updatedCount} 个 Agent 已更新` : ""}`,
          );
          return;
        }

        if (selfUpdated || updatedCount > 0) {
          log.success(
            `更新完成：${rollStatus}${updatedCount > 0 ? `，${updatedCount} 个 Agent 已更新` : ""}`,
          );
        } else if (info.unavailable) {
          log.info(`${rollStatus}；Agent 更新检查已完成`);
        } else if (agentsConfig === undefined || store === undefined) {
          log.success("roll 已是最新版本；Agent 更新已跳过");
        } else {
          log.success("一切都已是最新版本");
        }
      });
    } catch (error) {
      if (store !== undefined && agentsConfig !== undefined) {
        await withExecutionEnvironment(executionEnvironment, () =>
          restorePersistentManagedAgents(managedRuntimeBaselines, store!, agentsConfig!.dataDir),
        ).catch(() => {});
      }
      log.error(`更新流程异常中止：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      releaseUpdateMaintenanceGuards(maintenanceGuards);
      registryLock?.release();
      schedulerAdmissionLock?.release();
      await preparedDistribution?.dispose();
    }
  },
});

async function maybeRestartManagedAgent(
  agent: RegisteredAgent,
  wasRunning: boolean,
  shouldRestart: boolean,
  dataDir: string,
  maintenanceGuard?: AgentUsageMaintenanceGuard,
): Promise<void> {
  if (!wasRunning || agent.runtime.ownership !== "core-managed") {
    return;
  }

  if (maintenanceGuard === undefined) {
    await stopAgentGracefully(dataDir, agent.skill.name);
  }
  if (shouldRestart) {
    await startManagedAgentAndWait(agent, dataDir, maintenanceGuard);
  }
}

async function startManagedAgentAndWait(
  agent: RegisteredAgent,
  dataDir: string,
  maintenanceGuard?: AgentUsageMaintenanceGuard,
): Promise<void> {
  let started = false;
  try {
    startAgent(agent, dataDir, getAgentEnv(loadConfig().config, agent.skill.name), {
      ...(maintenanceGuard ? { lifecycleLock: maintenanceGuard.lifecycleLock } : {}),
      retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
    });
    started = true;
    await waitForAgentReady(agent, { startupTimeoutMs: 15_000, probeTimeoutMs: 2_000 });
  } catch (err) {
    if (started) {
      await stopAgentGracefully(dataDir, agent.skill.name, {
        ...(maintenanceGuard ? { lifecycleLock: maintenanceGuard.lifecycleLock } : {}),
      }).catch(() => {});
    }
    throw err;
  }
}

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

async function reportCompanionServiceAfterUpdate(
  warn: (message: string) => void = log.warn,
): Promise<void> {
  try {
    const serviceModule = (await import(
      new URL(`../../companion-host/service.${commandExtension}`, import.meta.url).href
    )) as typeof import("../../companion-host/service.ts");
    const pathsModule = (await import(
      new URL(`../../companion-host/paths.${commandExtension}`, import.meta.url).href
    )) as typeof import("../../companion-host/paths.ts");
    const service = serviceModule.createPlatformServiceController({
      identity: serviceModule.companionServiceIdentity(
        pathsModule.createCompanionPaths(),
        createBundledRollInvocation(),
      ),
    });
    const status = await service.status();
    if (status.installed) {
      // Companion currently has no atomic admission/idle handshake. A status snapshot cannot
      // authorize stopping remote sessions, so keep its old immutable distribution available.
      warn(
        "Companion 服务暂保留原版本（无法原子确认会话空闲）；会话结束后运行 roll companion service install 切换到新版本。",
      );
    }
  } catch (error) {
    warn(
      `无法确认 Companion 服务状态，未重启服务：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadScheduleServiceUtils(): Promise<typeof import("./schedule-service-utils.ts")> {
  const specifier = new URL(`./schedule-service-utils.${commandExtension}`, import.meta.url).href;
  const utils: typeof import("./schedule-service-utils.ts") = await import(specifier);
  return utils;
}

function runSchedulerServiceRestartInFreshProcess(): Promise<SchedulerServiceRestartRun> {
  const invocation = createBundledRollInvocation();
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      [
        ...invocation.execArgv,
        invocation.cliEntrypoint,
        "schedule",
        "service",
        "restart",
        "--json",
      ],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        if (error.killed === true) {
          resolve({ exitCode: null, stdout, stderr: `${stderr}\n子进程超时被终止` });
          return;
        }
        reject(error);
      },
    );
  });
}

async function reportSchedulerServiceBinaryDrift(): Promise<void> {
  try {
    const utils = await loadScheduleServiceUtils();
    const probe = await utils.probeSchedulerService();
    if (probe.error !== undefined) {
      log.warn(`无法检查 scheduler service 二进制状态：${probe.error}`);
      return;
    }
    if (!probe.installed || probe.binary === undefined || probe.binary.reason === undefined) {
      return;
    }
    log.warn(`scheduler service: ${probe.binary.reason}`);
  } catch (error) {
    log.warn(
      `无法检查 scheduler service 二进制状态：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
