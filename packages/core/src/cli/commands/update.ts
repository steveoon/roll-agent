import { defineCommand } from "citty";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectConfigFile, loadAgentsConfig, type ConfigInspectionResult } from "../../config/loader.ts";
import {
  getAgentPid,
  startAgent,
  stopAgentGracefully,
  waitForAgentReady,
} from "../../registry/process-manager.ts";
import { resolveTransportWithDevSpawnSpec } from "../../registry/dev-spawn.ts";
import { runAgentSetup } from "../../registry/runtime-setup.ts";
import { AgentStore } from "../../registry/store.ts";
import { discoverAgent } from "../../registry/discovery.ts";
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
  type PublishedPackageUpdateInfo,
  type PublishedPackageUpdateStatus,
} from "../utils/update-checker.ts";
import type { AgentSourceType, RegisteredAgent } from "../../types/agent.ts";

const execFileAsync = promisify(execFile);

export { inferAgentSourceType as inferSourceType } from "../../registry/source.ts";

function logConfigInspectionNotice(
  inspection: ConfigInspectionResult,
  mode: "check" | "pre-update" | "post-update",
): void {
  switch (inspection.status) {
    case "needs-migration": {
      const title =
        mode === "post-update" ? "升级后需要迁移本地配置" : "检测到本地配置需要迁移";
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

interface InstalledPackageUpdateResult {
  readonly packageRoot: string;
  readonly packageName: string;
  readonly installedVersion?: string;
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
      return info.currentVersion
        ? `已是最新版本 (v${info.currentVersion})`
        : "已是最新版本";
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

/** 更新 roll-core 自身 */
async function updateSelf(latest: string, dryRun: boolean): Promise<boolean> {
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
  try {
    await execFileAsync("npm", ["install", "-g", `@roll-agent/core@${latest}`], {
      timeout: 60_000,
    });
    spinner.succeed(`roll 已更新到 v${latest}`);
    return true;
  } catch (err) {
    spinner.fail("更新失败");
    log.error(err instanceof Error ? err.message : String(err));
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
        log.warn(
          `${agent.skill.name} 未检测到 packageManager 或 lockfile，跳过依赖安装。`,
        );
      } else {
        const depSpinner = createSpinner(`安装 ${agent.skill.name} 依赖...`).start();
        try {
          await execFileAsync(installCommand.command, installCommand.args, {
            cwd: agent.installPath,
            timeout: 60_000,
          });
          depSpinner.succeed(
            `${agent.skill.name} 依赖已更新 (${installCommand.command} ${installCommand.args.join(" ")})`,
          );
        } catch (err) {
          depSpinner.fail(`${agent.skill.name} 依赖安装失败`);
          log.error(err instanceof Error ? err.message : String(err));
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

/** 重新安装 npm 来源的 Agent */
async function updateInstalledAgent(
  agent: RegisteredAgent,
): Promise<InstalledPackageUpdateResult | undefined> {
  if (agent.source?.type !== "installed-package") {
    return undefined;
  }

  const spinner = createSpinner(`更新 ${agent.skill.name} (npm install)...`).start();
  try {
    await execFileAsync(
      "npm",
      ["install", "--prefix", agent.source.installDir, agent.source.packageSpec],
      { timeout: 120_000 },
    );

    const packageRoot = resolveInstalledPackageRoot(
      agent.source.installDir,
      agent.source.packageName,
    );
    if (!existsSync(packageRoot)) {
      throw new Error(`Installed package root not found: ${packageRoot}`);
    }
    const manifest = readInstalledPackageManifest(packageRoot);

    spinner.succeed(`${agent.skill.name} 已重新安装`);
    return {
      packageRoot,
      packageName: manifest?.name ?? agent.source.packageName,
      ...(manifest?.version ? { installedVersion: manifest.version } : {}),
    };
  } catch (err) {
    spinner.fail(`${agent.skill.name} 更新失败`);
    log.error(err instanceof Error ? err.message : String(err));
    return undefined;
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

export default defineCommand({
  meta: { description: "更新 roll 及已注册的 Agent" },
  args: {
    check: {
      type: "boolean",
      description: "仅检查可用更新，不执行",
      default: false,
    },
    skipBrowserSetup: {
      type: "boolean",
      description: "跳过浏览器运行时安装",
      default: false,
    },
  },
  async run({ args }) {
    const isCheckOnly = args.check;
    const configInspection = inspectConfigFile();

    // === 1. 检查 roll-core 自身 ===
    log.info("检查 roll 更新...");
    const info = await checkForUpdate({ forceRefresh: true });

    if (info.hasUpdate) {
      log.success(`roll 有新版本: v${info.current} → v${info.latest}`);
    } else {
      log.info(`roll 已是最新版本 (v${info.current})`);
    }

    // === 2. 检查已注册 Agent ===
    let agentsConfig: ReturnType<typeof loadAgentsConfig>["agentsConfig"] | undefined;
    let store: AgentStore | undefined;
    let agents: readonly RegisteredAgent[] = [];

    try {
      agentsConfig = loadAgentsConfig().agentsConfig;
      store = new AgentStore(agentsConfig.dataDir);
      agents = store.list();
    } catch (err) {
      log.warn(`无法读取 Agent 配置，跳过已注册 Agent 检查：${err instanceof Error ? err.message : String(err)}`);
    }

    const agentSummary: AgentCheckSummary[] = [];

    for (const listedAgent of agents) {
      let agent = listedAgent;
      const initialSourceType = inferAgentSourceType(agent);

      if (initialSourceType === "installed-package") {
        agent = hydrateInstalledPackageAgent(agent, store);
      }

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
            { forceRefresh: true },
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

    // 3a. 更新 roll-core
    let selfUpdated = false;
    let selfUpdateFailed = false;
    if (info.hasUpdate) {
      selfUpdated = await updateSelf(info.latest, false);
      if (!selfUpdated) selfUpdateFailed = true;
    }

    if (
      selfUpdated &&
      (configInspection.status === "needs-migration" || configInspection.status === "invalid")
    ) {
      log.info("");
      logConfigInspectionNotice(configInspection, "post-update");
    }

    // 3b. 更新 Agent
    let updatedCount = 0;
    let failedCount = 0;

    for (const agent of agents) {
      if (!store || !agentsConfig) {
        break;
      }
      const sourceType = inferAgentSourceType(agent);

      switch (sourceType) {
        case "git": {
          const wasRunning =
            agent.runtime.ownership === "core-managed" &&
            getAgentPid(agentsConfig.dataDir, agent.skill.name) !== undefined;
          const ok = await updateGitAgent(agent);
          if (ok) {
            // 重新解析 SKILL.md 并更新 store
            try {
              const discovered = discoverAgent(agent.installPath);
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
                await maybeRestartManagedAgent(updated, wasRunning, agentsConfig.dataDir);
                updatedCount++;
              }
            } catch (err) {
              store.updateStatus(agent.skill.name, "error");
              log.warn(
                `${agent.skill.name} metadata 刷新或重启失败: ${err instanceof Error ? err.message : String(err)}`,
              );
              failedCount++;
            }
          } else {
            failedCount++;
          }
          break;
        }
        case "installed-package": {
          const wasRunning =
            agent.runtime.ownership === "core-managed" &&
            getAgentPid(agentsConfig.dataDir, agent.skill.name) !== undefined;
          if (wasRunning) {
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

          const updateResult = await updateInstalledAgent(agent);
          if (updateResult) {
            try {
              const discovered = discoverAgent(updateResult.packageRoot);
              const updatedSource =
                agent.source?.type === "installed-package"
                  ? {
                      ...agent.source,
                      packageName: updateResult.packageName,
                      ...(updateResult.installedVersion
                        ? { installedVersion: updateResult.installedVersion }
                        : {}),
                    }
                  : undefined;
              const updated: RegisteredAgent = {
                ...agent,
                skill: discovered.skill,
                transport: discovered.transport,
                runtime: discovered.runtime,
                installPath: updateResult.packageRoot,
                ...(updatedSource ? { source: updatedSource } : {}),
                ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
              };
              const setupResult = await runAgentSetup(updated, {
                skipBrowserSetup: args.skipBrowserSetup,
              });
              if (!setupResult.ok) {
                log.warn(`${updated.skill.name} setup 失败：${setupResult.message}`);
                if (setupResult.retryCommand) {
                  log.info(`重试命令: ${setupResult.retryCommand}`);
                }
              }
              const replaced = store.replace(agent.skill.name, updated);
              if (!replaced) {
                log.warn(`${agent.skill.name} 已从注册表中移除，跳过元数据刷新`);
                failedCount++;
              } else if (!setupResult.ok) {
                store.updateStatus(updated.skill.name, "error");
                failedCount++;
              } else {
                if (wasRunning) {
                  await startManagedAgentAndWait(updated, agentsConfig.dataDir);
                }
                updatedCount++;
              }
            } catch (err) {
              store.updateStatus(agent.skill.name, "error");
              log.warn(
                `${agent.skill.name} metadata 刷新、setup 或重启失败: ${err instanceof Error ? err.message : String(err)}`,
              );
              failedCount++;
            }
          } else {
            if (wasRunning) {
              try {
                await startManagedAgentAndWait(agent, agentsConfig.dataDir);
              } catch {
                store.updateStatus(agent.skill.name, "error");
              }
            }
            failedCount++;
          }
          break;
        }
        case "remote-manifest": {
          try {
            const discovered = discoverAgent(agent.installPath);
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
            log.warn(
              `${agent.skill.name} manifest 刷新失败: ${err instanceof Error ? err.message : String(err)}`,
            );
            failedCount++;
          }
          break;
        }
        case "local-path": {
            const wasRunning =
              agent.runtime.ownership === "core-managed" &&
              getAgentPid(agentsConfig.dataDir, agent.skill.name) !== undefined;
          try {
            const discovered = discoverAgent(agent.installPath);
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
              await maybeRestartManagedAgent(updated, wasRunning, agentsConfig.dataDir);
              updatedCount++;
            }
          } catch (err) {
            store.updateStatus(agent.skill.name, "error");
            log.warn(
              `${agent.skill.name} 本地 metadata 刷新或重启失败: ${err instanceof Error ? err.message : String(err)}`,
            );
            failedCount++;
          }
          break;
        }
      }
    }

    // === 4. 总结 ===
    log.info("");
    const totalFailed = failedCount + (selfUpdateFailed ? 1 : 0);
    if (totalFailed > 0) {
      process.exitCode = 1;
      const rollStatus = selfUpdateFailed
        ? "roll 更新失败"
        : selfUpdated
          ? "roll ✓"
          : "roll 无更新";
      log.warn(
        `更新完成但有失败：${rollStatus}${
          failedCount > 0 ? `，${failedCount} 个 Agent 更新失败` : ""
        }${updatedCount > 0 ? `，${updatedCount} 个 Agent 已更新` : ""}`,
      );
      return;
    }

    if (selfUpdated || updatedCount > 0) {
      log.success(
        `更新完成：${selfUpdated ? "roll ✓" : "roll 无更新"}${
          updatedCount > 0 ? `，${updatedCount} 个 Agent 已更新` : ""
        }`,
      );
    } else {
      log.success("一切都已是最新版本");
    }
  },
});

interface InstallCommandSpec {
  readonly command: "bun" | "npm" | "pnpm" | "yarn";
  readonly args: readonly ["install"];
}

export function detectInstallCommand(projectDir: string): InstallCommandSpec | undefined {
  const packageJsonPath = resolve(projectDir, "package.json");
  if (existsSync(packageJsonPath)) {
    const packageManager = readPackageManager(packageJsonPath);
    if (packageManager) {
      return {
        command: packageManager,
        args: ["install"],
      };
    }
  }

  const lockfileEntries: ReadonlyArray<readonly [string, InstallCommandSpec["command"]]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];

  for (const [lockfile, command] of lockfileEntries) {
    if (existsSync(resolve(projectDir, lockfile))) {
      return {
        command,
        args: ["install"],
      };
    }
  }

  return undefined;
}

async function maybeRestartManagedAgent(
  agent: RegisteredAgent,
  wasRunning: boolean,
  dataDir: string,
): Promise<void> {
  if (!wasRunning || agent.runtime.ownership !== "core-managed") {
    return;
  }

  await stopAgentGracefully(dataDir, agent.skill.name);
  await startManagedAgentAndWait(agent, dataDir);
}

async function startManagedAgentAndWait(
  agent: RegisteredAgent,
  dataDir: string,
): Promise<void> {
  let started = false;
  try {
    startAgent(agent, dataDir);
    started = true;
    await waitForAgentReady(agent, { startupTimeoutMs: 15_000, probeTimeoutMs: 2_000 });
  } catch (err) {
    if (started) {
      await stopAgentGracefully(dataDir, agent.skill.name).catch(() => {});
    }
    throw err;
  }
}

function readPackageManager(packageJsonPath: string): InstallCommandSpec["command"] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      readonly packageManager?: unknown;
    };
    if (typeof parsed.packageManager !== "string" || parsed.packageManager.length === 0) {
      return undefined;
    }

    const name = parsed.packageManager.split("@", 1)[0];
    if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") {
      return name;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
