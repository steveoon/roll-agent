import { defineCommand } from "citty";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { discoverAgent } from "../../registry/discovery.ts";
import {
  inferAgentSourceType,
  resolveInstalledPackageRoot,
} from "../../registry/source.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { log, createSpinner } from "../utils/output.ts";
import {
  checkForUpdate,
  getCurrentVersion,
} from "../utils/update-checker.ts";
import type { AgentSourceType, RegisteredAgent } from "../../types/agent.ts";

const execFileAsync = promisify(execFile);

export { inferAgentSourceType as inferSourceType } from "../../registry/source.ts";

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
      const depSpinner = createSpinner(`安装 ${agent.skill.name} 依赖...`).start();
      try {
        await execFileAsync("pnpm", ["install"], { cwd: agent.installPath, timeout: 60_000 });
        depSpinner.succeed(`${agent.skill.name} 依赖已更新`);
      } catch (err) {
        depSpinner.fail(`${agent.skill.name} 依赖安装失败`);
        log.error(err instanceof Error ? err.message : String(err));
        return false;
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
async function updateInstalledAgent(agent: RegisteredAgent): Promise<boolean> {
  if (agent.source?.type !== "installed") {
    return false;
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

    spinner.succeed(`${agent.skill.name} 已重新安装`);
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
    const client = await manager.connect(agent.skill.name, agent.transport, agent.installPath);
    const { tools } = await client.listTools();
    spinner.succeed(
      `${agent.skill.name} 元数据已刷新（${tools.length} 个 tool）`,
    );
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
  },
  async run({ args }) {
    const isCheckOnly = args.check;

    // === 1. 检查 roll-core 自身 ===
    log.info("检查 roll 更新...");
    const info = await checkForUpdate({ forceRefresh: true });

    if (info.hasUpdate) {
      log.success(`roll 有新版本: v${info.current} → v${info.latest}`);
    } else {
      log.info(`roll 已是最新版本 (v${info.current})`);
    }

    // === 2. 检查已注册 Agent ===
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
    const agents = store.list();

    const agentSummary: Array<{
      name: string;
      sourceType: AgentSourceType;
      action: string;
    }> = [];

    for (const agent of agents) {
      const sourceType = inferAgentSourceType(agent);
      let action: string;
      switch (sourceType) {
        case "git":
          action = "git pull + 重新安装依赖";
          break;
        case "installed":
          action = "重新安装 npm 包";
          break;
        case "remote":
          action = "刷新 MCP 元数据 (tools/list)";
          break;
        case "local":
          action = "跳过（本地 Agent 请手动更新）";
          break;
      }
      agentSummary.push({ name: agent.skill.name, sourceType, action });
    }

    if (agents.length > 0) {
      log.info(`\n已注册 Agent (${agents.length}):`);
      for (const s of agentSummary) {
        const tag = s.sourceType === "local" ? "⏭" : "⬆";
        log.info(`  ${tag} ${s.name} [${s.sourceType}] — ${s.action}`);
      }
    } else {
      log.info("无已注册 Agent");
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

    // 3b. 更新 Agent
    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const agent of agents) {
      const sourceType = inferAgentSourceType(agent);

      switch (sourceType) {
        case "git": {
          const ok = await updateGitAgent(agent);
          if (ok) {
            // 重新解析 SKILL.md 并更新 store
            try {
              const discovered = discoverAgent(agent.installPath);
              const updated: RegisteredAgent = {
                ...agent,
                skill: discovered.skill,
                transport: discovered.transport,
                ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
              };
              const replaced = store.replace(agent.skill.name, updated);
              if (!replaced) {
                log.warn(`${agent.skill.name} 已从注册表中移除，跳过元数据刷新`);
              }
            } catch (err) {
              log.warn(`${agent.skill.name} SKILL.md 重新解析失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            updatedCount++;
          } else {
            failedCount++;
          }
          break;
        }
        case "installed": {
          const ok = await updateInstalledAgent(agent);
          if (ok) {
            try {
              const discovered = discoverAgent(agent.installPath);
              const updated: RegisteredAgent = {
                ...agent,
                skill: discovered.skill,
                transport: discovered.transport,
                ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
              };
              const replaced = store.replace(agent.skill.name, updated);
              if (!replaced) {
                log.warn(`${agent.skill.name} 已从注册表中移除，跳过元数据刷新`);
              }
            } catch (err) {
              log.warn(`${agent.skill.name} SKILL.md 重新解析失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            updatedCount++;
          } else {
            failedCount++;
          }
          break;
        }
        case "remote": {
          const ok = await refreshRemoteAgent(agent);
          if (ok) {
            updatedCount++;
          } else {
            failedCount++;
          }
          break;
        }
        case "local":
          log.warn(`${agent.skill.name} 是本地 Agent，请手动更新后运行 roll agent add <path> 重新注册`);
          skippedCount++;
          break;
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
        }${updatedCount > 0 ? `，${updatedCount} 个 Agent 已更新` : ""}${
          skippedCount > 0 ? `，${skippedCount} 个已跳过` : ""
        }`,
      );
      return;
    }

    if (selfUpdated || updatedCount > 0) {
      log.success(
        `更新完成：${selfUpdated ? "roll ✓" : "roll 无更新"}${
          updatedCount > 0 ? `，${updatedCount} 个 Agent 已更新` : ""
        }${skippedCount > 0 ? `，${skippedCount} 个已跳过` : ""}`,
      );
    } else {
      log.success("一切都已是最新版本");
    }
  },
});
