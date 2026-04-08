import { defineCommand } from "citty";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectAgentEnvRequirements } from "../../config/helpers.ts";
import { loadAgentsConfig } from "../../config/loader.ts";
import { discoverAgent } from "../../registry/discovery.ts";
import {
  startAgent,
  stopAgentGracefully,
  waitForAgentReady,
} from "../../registry/process-manager.ts";
import { runAgentSetup } from "../../registry/runtime-setup.ts";
import { AgentStore } from "../../registry/store.ts";
import {
  parsePackageName,
  readInstalledPackageManifest,
  resolveInstalledPackageRoot,
  sanitizeInstallId,
} from "../../registry/source.ts";
import { log } from "../utils/output.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

const execFileAsync = promisify(execFile);

function isGitUrl(input: string): boolean {
  return (
    input.startsWith("git@") ||
    input.startsWith("git+") ||
    input.startsWith("github:") ||
    input.startsWith("gitlab:") ||
    input.startsWith("bitbucket:") ||
    input.endsWith(".git")
  );
}

export default defineCommand({
  meta: { description: "安装已编译的 Agent 包并注册到本地" },
  args: {
    package: { type: "positional", description: "npm package spec", required: true },
    skipBrowserSetup: {
      type: "boolean",
      description: "跳过浏览器运行时安装",
      default: false,
    },
    noStart: {
      type: "boolean",
      description: "安装后不自动启动 core-managed Agent",
      default: false,
    },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const packageSpec = args.package;

    if (isGitUrl(packageSpec)) {
      log.error(`Git URL 请使用 \`roll agent add ${packageSpec}\` 注册，不要使用 \`roll agent install\``);
      process.exitCode = 1;
      return;
    }

    const resolvedInputPath = resolve(packageSpec);
    if (existsSync(resolvedInputPath) && statSync(resolvedInputPath).isDirectory()) {
      log.error(
        `本地源码目录请使用 \`roll agent add ${packageSpec}\` 注册，不要使用 \`roll agent install\``,
      );
      process.exitCode = 1;
      return;
    }

    const packageName = parsePackageName(packageSpec);
    const installDir = resolve(agentsConfig.dataDir, "installed", sanitizeInstallId(packageName));

    if (!existsSync(installDir)) {
      mkdirSync(installDir, { recursive: true });
    }

    log.info(`安装 ${packageSpec}...`);
    try {
      await execFileAsync("npm", ["install", "--prefix", installDir, packageSpec], {
        timeout: 120_000,
      });
    } catch (err) {
      log.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    const packageRoot = resolveInstalledPackageRoot(installDir, packageName);
    if (!existsSync(packageRoot)) {
      log.error(`安装完成但未找到包目录: ${packageRoot}`);
      process.exitCode = 1;
      return;
    }
    const installedManifest = readInstalledPackageManifest(packageRoot);

    log.info("解析已安装 Agent 的 SKILL.md...");
    const discovered = discoverAgent(packageRoot);
    const store = new AgentStore(agentsConfig.dataDir);

    const agent: RegisteredAgent = {
      skill: discovered.skill,
      transport: discovered.transport,
      runtime: discovered.runtime,
      installPath: packageRoot,
      registeredAt: new Date().toISOString(),
      status: "idle",
      source: {
        type: "installed-package",
        packageName: installedManifest?.name ?? packageName,
        packageSpec,
        installDir,
        ...(installedManifest?.version ? { installedVersion: installedManifest.version } : {}),
      },
      ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
    };

    if (
      agent.runtime.ownership === "core-managed" &&
      agent.runtime.setup?.playwright &&
      !args.skipBrowserSetup
    ) {
      log.info(
        `即将安装浏览器运行时 (${agent.runtime.setup.playwright.browsers.join(", ")})，这可能需要一些时间...`,
      );
    }

    const setupResult = await runAgentSetup(agent, {
      skipBrowserSetup: args.skipBrowserSetup,
    });
    if (!setupResult.ok) {
      log.warn(`Agent setup 失败：${setupResult.message}`);
      if (setupResult.retryCommand) {
        log.info(`重试命令: ${setupResult.retryCommand}`);
      }
    } else if (!setupResult.skipped) {
      log.success(setupResult.message);
    } else {
      log.info(setupResult.message);
    }

    const existing = store.findByName(discovered.skill.name);
    try {
      const wasRunning =
        existing?.runtime.ownership === "core-managed" &&
        existing.status === "online";

      if (existing?.source?.type === "installed-package") {
        store.replace(existing.skill.name, agent);
      } else {
        store.add(agent);
      }

      if (!setupResult.ok) {
        store.updateStatus(discovered.skill.name, "error");
        process.exitCode = 1;
        return;
      }

      if (agent.runtime.ownership === "core-managed" && !args.noStart) {
        if (wasRunning) {
          await stopAgentGracefully(agentsConfig.dataDir, agent.skill.name);
        }
        store.updateStatus(agent.skill.name, "starting");
        let started = false;
        try {
          startAgent(agent, agentsConfig.dataDir);
          started = true;
          await waitForAgentReady(agent, { startupTimeoutMs: 15_000, probeTimeoutMs: 2_000 });
          store.updateStatus(agent.skill.name, "online");
        } catch (err) {
          if (started) {
            await stopAgentGracefully(agentsConfig.dataDir, agent.skill.name).catch(() => {});
          }
          store.updateStatus(agent.skill.name, "error");
          log.error(
            `Agent "${discovered.skill.name}" 已安装，但自动启动失败：${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
          return;
        }
      }

      log.success(`Agent "${discovered.skill.name}" 安装并注册成功`);
      reportAgentEnvGuidance(discovered.skill.name, discovered.skill.env, agentsConfig.env);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});

function reportAgentEnvGuidance(
  agentName: string,
  envDeclarations: RegisteredAgent["skill"]["env"],
  envMap: ReturnType<typeof loadAgentsConfig>["agentsConfig"]["env"],
): void {
  const envReport = inspectAgentEnvRequirements(agentName, envDeclarations, envMap);
  if (!envReport) {
    return;
  }

  if (envReport.missingRequired.length > 0) {
    log.warn(
      `Agent "${agentName}" 仍缺少必填环境变量: ${envReport.missingRequired.map((item) => item.name).join(", ")}`,
    );
    log.info(`请在 roll.config.yaml 的 agents.env.${agentName} 中显式配置这些项。`);
    return;
  }

  if (envReport.processEnvOnlyRequired.length > 0) {
    log.warn(
      `Agent "${agentName}" 当前依赖 shell 环境变量: ${envReport.processEnvOnlyRequired.map((item) => item.name).join(", ")}`,
    );
    log.info(`建议将这些项写入 roll.config.yaml 的 agents.env.${agentName}。`);
  }
}
