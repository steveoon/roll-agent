import { defineCommand } from "citty";
import { getAgentEnv } from "../../config/helpers.ts";
import { loadAgentsConfig, loadConfig, loadInstallConfig } from "../../config/loader.ts";
import { catalogPackageSpec } from "../../registry/catalog.ts";
import { resolveAgentCatalog } from "../../registry/catalog-discovery.ts";
import { installAgent } from "../../registry/install.ts";
import { AgentStore } from "../../registry/store.ts";
import { inspectCatalogAvailability } from "../utils/catalog-status.ts";
import { log } from "../utils/output.ts";
import { setupAgentEnv, setupBash, setupInstall, setupLlm } from "./config-setup.ts";
import { ConfigSetupCancelledError, clackPromptAdapter } from "./config-prompts.ts";
import type { CatalogAvailabilityItem, CatalogInstallState } from "../utils/catalog-status.ts";
import type { ConfigPromptAdapter } from "./config-prompts.ts";
import type {
  InstallAgentEvent,
  InstallAgentFailure,
  InstallAgentSuccess,
} from "../../registry/install.ts";
import type { RegisteredAgent } from "../../types/agent.ts";
import type { RollConfig } from "../../config/schema.ts";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

export interface LlmConfigStatus {
  readonly configured: boolean;
  readonly summary: string;
}

export interface SetupAgentContext {
  readonly agentsConfig: RollConfig["agents"];
  readonly installConfig?: RollConfig["install"];
  readonly installConfigError?: string;
  readonly agents: readonly RegisteredAgent[];
}

export interface RunSetupDeps {
  readonly prompts?: ConfigPromptAdapter;
  readonly detectLlm?: () => LlmConfigStatus;
  readonly setupLlmFn?: typeof setupLlm;
  readonly setupInstallFn?: typeof setupInstall;
  readonly setupBashFn?: typeof setupBash;
  readonly setupAgentEnvFn?: typeof setupAgentEnv;
  readonly loadAgentContext?: () => SetupAgentContext;
  readonly resolveCatalog?: typeof resolveAgentCatalog;
  readonly inspectAvailability?: typeof inspectCatalogAvailability;
  readonly install?: typeof installAgent;
  readonly runDoctor?: () => Promise<void>;
}

export async function runSetup(deps: RunSetupDeps = {}): Promise<void> {
  const prompts = deps.prompts ?? clackPromptAdapter;
  const detectLlm = deps.detectLlm ?? detectLlmConfigStatus;
  const setupLlmFn = deps.setupLlmFn ?? setupLlm;
  const setupInstallFn = deps.setupInstallFn ?? setupInstall;
  const setupBashFn = deps.setupBashFn ?? setupBash;
  const setupAgentEnvFn = deps.setupAgentEnvFn ?? setupAgentEnv;
  const runDoctor = deps.runDoctor ?? runDoctorCommand;

  try {
    prompts.intro("Roll 一键初始化");

    const llmStatus = detectLlm();
    if (llmStatus.configured) {
      const reconfigure = await prompts.confirm({
        message: `已检测到 LLM 配置（${llmStatus.summary}），是否重新配置？`,
        initialValue: false,
      });
      if (reconfigure) {
        prompts.info(await setupLlmFn(prompts));
      }
    } else {
      prompts.info(await setupLlmFn(prompts));
    }

    const configureInstall = await prompts.confirm({
      message: "是否配置安装网络（npm registry / 重试 / 超时）？",
      initialValue: false,
    });
    if (configureInstall) {
      prompts.info(await setupInstallFn(prompts));
    }

    const configureBash = await prompts.confirm({
      message: "是否配置 chat 内建 bash 工具（默认关闭）？",
      initialValue: false,
    });
    if (configureBash) {
      prompts.info(await setupBashFn(prompts));
    }

    const installed = await installOfficialAgents(prompts, deps);

    for (const result of installed) {
      if (!result.envReport || result.envReport.missingRequired.length === 0) {
        continue;
      }
      const configureEnv = await prompts.confirm({
        message: `Agent "${result.agent.skill.name}" 缺少必填环境变量，现在配置？`,
        initialValue: true,
      });
      if (configureEnv) {
        prompts.info(await setupAgentEnvFn(result.agent.skill.name, prompts));
      }
      if (!result.started && result.agent.runtime.ownership === "core-managed") {
        prompts.info(`运行 roll agent start ${result.agent.skill.name} 启动该 Agent。`);
      }
    }

    prompts.info("运行 roll doctor 检查...");
    await runDoctor();

    prompts.outro("初始化完成。下一步：`roll chat` 开始对话，或 `roll agent list` 查看已注册 Agent。");
  } catch (err) {
    if (err instanceof ConfigSetupCancelledError) {
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

export async function runChatOnboarding(deps: RunSetupDeps = {}): Promise<boolean> {
  const prompts = deps.prompts ?? clackPromptAdapter;
  const detectLlm = deps.detectLlm ?? detectLlmConfigStatus;
  const setupLlmFn = deps.setupLlmFn ?? setupLlm;

  try {
    prompts.intro("Roll chat 初始化");
    const proceed = await prompts.confirm({
      message: "LLM provider 尚未配置，现在进入初始化向导吗？",
      initialValue: true,
    });
    if (!proceed) {
      prompts.outro("已跳过初始化。");
      return false;
    }

    if (!detectLlm().configured) {
      prompts.info(await setupLlmFn(prompts));
    }
    const installed = await installOfficialAgents(prompts, deps);
    for (const result of installed) {
      if (!result.envReport || result.envReport.missingRequired.length === 0) {
        continue;
      }
      prompts.warn(
        `Agent "${result.agent.skill.name}" 缺少必填环境变量，可运行 roll config setup agent ${result.agent.skill.name} 配置。`,
      );
    }
    prompts.outro("初始化完成，继续进入对话。完整初始化可运行 roll setup，环境检查可运行 roll doctor。");
    return true;
  } catch (err) {
    if (err instanceof ConfigSetupCancelledError) {
      return false;
    }
    throw err;
  }
}

async function installOfficialAgents(
  prompts: ConfigPromptAdapter,
  deps: RunSetupDeps,
): Promise<readonly InstallAgentSuccess[]> {
  const loadAgentContext = deps.loadAgentContext ?? loadSetupAgentContext;
  const resolveCatalog = deps.resolveCatalog ?? resolveAgentCatalog;
  const inspectAvailability = deps.inspectAvailability ?? inspectCatalogAvailability;
  const install = deps.install ?? installAgent;

  const context = loadAgentContext();
  if (!context.installConfig) {
    prompts.warn(`install 配置无效，跳过官方 Agent 安装：${context.installConfigError ?? "未知原因"}`);
    return [];
  }
  const installConfig = context.installConfig;

  const catalog = await resolveCatalog(undefined, {
    ...(installConfig.registry ? { registry: installConfig.registry } : {}),
  });
  const availability = await inspectAvailability(catalog, context.agents, {
    ...(installConfig.registry ? { registry: installConfig.registry } : {}),
  });
  if (availability.length === 0) {
    return [];
  }

  const selected = await prompts.multiselect({
    message: "选择要安装的官方 Agent（空格勾选，回车确认，可全部跳过）",
    options: availability.map((item) => ({
      value: item.entry.shortName,
      label: item.entry.shortName,
      hint: buildAvailabilityHint(item),
    })),
    initialValues: availability
      .filter((item) => item.state === "not-installed")
      .map((item) => item.entry.shortName),
    required: false,
  });

  const results: InstallAgentSuccess[] = [];
  for (const shortName of selected) {
    const item = availability.find((candidate) => candidate.entry.shortName === shortName);
    if (!item) {
      continue;
    }
    const result = await install(
      { packageSpec: catalogPackageSpec(item.entry) },
      {
        agentsConfig: context.agentsConfig,
        installConfig,
        getStartEnv: (agentName) => getAgentEnv(loadConfig().config, agentName),
        report: (event) => renderSetupInstallEvent(prompts, event),
      },
    );
    if (result.ok) {
      prompts.info(`Agent "${result.agent.skill.name}" 安装并注册成功`);
      results.push(result);
    } else {
      renderSetupInstallFailure(prompts, result);
    }
  }
  return results;
}

function detectLlmConfigStatus(): LlmConfigStatus {
  try {
    const { config } = loadConfig();
    const provider = config.llm.defaultProvider;
    const apiKey = config.llm.providers[provider]?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim().length > 0) {
      return { configured: true, summary: `${provider}/${config.llm.defaultModel}` };
    }
  } catch {
    return { configured: false, summary: "" };
  }
  return { configured: false, summary: "" };
}

function loadSetupAgentContext(): SetupAgentContext {
  const { agentsConfig } = loadAgentsConfig();
  const store = new AgentStore(agentsConfig.dataDir);
  try {
    return {
      agentsConfig,
      installConfig: loadInstallConfig().installConfig,
      agents: store.list(),
    };
  } catch (error) {
    return {
      agentsConfig,
      installConfigError: error instanceof Error ? error.message : String(error),
      agents: store.list(),
    };
  }
}

function buildAvailabilityHint(item: CatalogAvailabilityItem): string {
  const installedVersion =
    item.installedAgent?.source?.type === "installed-package"
      ? item.installedAgent.source.installedVersion
      : undefined;
  const stateHints: Record<CatalogInstallState, () => string> = {
    "not-installed": () => (item.latestVersion ? `最新 v${item.latestVersion}` : "未安装"),
    installed: () =>
      item.update?.status === "update-available" && item.latestVersion
        ? `已安装${installedVersion ? ` v${installedVersion}` : ""}，可更新到 v${item.latestVersion}`
        : `已安装${installedVersion ? ` v${installedVersion}` : ""}`,
    "installed-other-source": () => "已通过其他来源注册，选择将替换为 npm 安装",
  };
  return `${item.entry.description}（${stateHints[item.state]()}）`;
}

function renderSetupInstallEvent(prompts: ConfigPromptAdapter, event: InstallAgentEvent): void {
  if (event.type === "retry") {
    prompts.warn(
      `安装遇到网络问题，${Math.round(event.delayMs / 1000)}s 后重试（第 ${event.attempt + 1} 次）...`,
    );
    return;
  }
  if (event.type === "warn") {
    prompts.warn(event.message);
    return;
  }
  prompts.info(event.message);
}

function renderSetupInstallFailure(prompts: ConfigPromptAdapter, failure: InstallAgentFailure): void {
  if (failure.step === "setup") {
    prompts.warn(`Agent setup 失败：${failure.message}`);
    if (failure.retryCommand) {
      prompts.info(`重试命令: ${failure.retryCommand}`);
    }
    return;
  }
  prompts.warn(failure.message);
}

async function runDoctorCommand(): Promise<void> {
  const specifier = new URL(`./doctor.${commandExtension}`, import.meta.url).href;
  const doctorCommand = (await import(specifier)).default;
  const { runCommand } = await import("citty");
  await runCommand(doctorCommand, { rawArgs: [] });
}

export default defineCommand({
  meta: { description: "一键初始化：配置 LLM、安装官方 Agent、检查环境（新设备 onboarding）" },
  args: {},
  async run() {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      log.error("roll setup 需要交互式终端。非交互环境请使用 roll config set 与 roll agent install。");
      process.exitCode = 1;
      return;
    }
    await runSetup();
  },
});
