import { defineCommand } from "citty";
import { getAgentEnv } from "../../config/helpers.ts";
import { loadAgentsConfig, loadConfig, loadInstallConfig } from "../../config/loader.ts";
import { catalogPackageSpec, findCatalogEntry } from "../../registry/catalog.ts";
import { resolveAgentCatalog } from "../../registry/catalog-discovery.ts";
import { installAgent } from "../../registry/install.ts";
import { log } from "../utils/output.ts";
import { reportAgentEnvGuidance } from "./agent-env-guidance.ts";
import type { InstallAgentEvent, InstallAgentFailure } from "../../registry/install.ts";
import type { RollConfig } from "../../config/schema.ts";

function renderInstallAgentEvent(event: InstallAgentEvent): void {
  if (event.type === "retry") {
    log.warn(
      `安装遇到网络问题，${Math.round(event.delayMs / 1000)}s 后重试（第 ${event.attempt + 1} 次）...`,
    );
    return;
  }
  const loggers: Record<Exclude<InstallAgentEvent["type"], "retry">, (message: string) => void> = {
    step: log.info,
    info: log.info,
    warn: log.warn,
    success: log.success,
  };
  loggers[event.type](event.message);
}

function renderInstallAgentFailure(failure: InstallAgentFailure): void {
  if (failure.step === "setup") {
    log.warn(`Agent setup 失败：${failure.message}`);
    if (failure.retryCommand) {
      log.info(`重试命令: ${failure.retryCommand}`);
    }
    return;
  }
  log.error(failure.message);
}

export default defineCommand({
  meta: { description: "安装已发布的 Agent npm 包并注册到本地" },
  args: {
    package: {
      type: "positional",
      description:
        "官方 Agent 短名（roll agent list --available 查看）、npm 包名、版本范围或 .tgz 路径（源码目录请用 roll agent add）",
      required: true,
    },
    "skip-browser-setup": {
      type: "boolean",
      description: "跳过 Playwright 浏览器运行时安装/校验",
      default: false,
    },
    start: {
      type: "boolean",
      description: "安装后不自动启动 core-managed Agent",
      default: true,
    },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    let installConfig: RollConfig["install"];
    try {
      installConfig = loadInstallConfig().installConfig;
    } catch (error) {
      log.error(
        `install 配置无效，已停止安装：${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      return;
    }

    const catalog = await resolveAgentCatalog(undefined, {
      ...(installConfig.registry ? { registry: installConfig.registry } : {}),
    });
    const catalogMatch = findCatalogEntry(catalog, args.package);
    const packageSpec = catalogMatch
      ? catalogPackageSpec(catalogMatch.entry, catalogMatch.versionSpec)
      : args.package;
    if (catalogMatch && packageSpec !== args.package) {
      log.info(`已识别官方 Agent 短名：${args.package} → ${packageSpec}`);
    }

    const result = await installAgent(
      {
        packageSpec,
        skipBrowserSetup: args["skip-browser-setup"],
        autoStart: args.start,
      },
      {
        agentsConfig,
        installConfig,
        getStartEnv: (agentName) => getAgentEnv(loadConfig().config, agentName),
        report: renderInstallAgentEvent,
      },
    );

    if (!result.ok) {
      renderInstallAgentFailure(result);
      process.exitCode = 1;
      return;
    }

    log.success(`Agent "${result.agent.skill.name}" 安装并注册成功`);
    reportAgentEnvGuidance(result.agent.skill.name, result.envReport);
  },
});
