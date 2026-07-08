import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  DEFAULT_CONFIG,
  DEFAULT_LLM_MODELS,
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDER_OPTIONS,
  type LlmProviderOption,
} from "../../config/defaults.ts";
import { inspectAgentEnvRequirements, type AgentEnvCheckItem } from "../../config/helpers.ts";
import {
  loadAgentsConfig,
  parseConfigDocument,
  resolveConfigPath,
  validateConfigText,
} from "../../config/loader.ts";
import { encodePathToYaml } from "../../config/key-codec.ts";
import { AgentStore } from "../../registry/store.ts";
import type { RegisteredAgent } from "../../types/agent.ts";
import {
  flattenAgentEnvDeclarations,
  isSecretEnvName,
  type InstallScenario,
} from "./config-guidance.ts";
import {
  ConfigSetupCancelledError,
  clackPromptAdapter,
  type ConfigPromptAdapter,
  type PromptOption,
} from "./config-prompts.ts";

export type ConfigSetupModule = "llm" | "install" | "agent" | "bash";

const ENV_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/u;

interface ConfigDocumentContext {
  readonly configPath: string;
  readonly existed: boolean;
  readonly document: Record<string, unknown>;
  readonly raw?: string;
}

export async function runConfigSetup(
  moduleArg: string | undefined,
  valueArg: string | undefined,
  prompts: ConfigPromptAdapter = clackPromptAdapter,
): Promise<void> {
  try {
    prompts.intro("Roll 配置向导");
    const moduleName = await resolveSetupModule(moduleArg, prompts);
    switch (moduleName) {
      case "llm":
        prompts.outro(await setupLlm(prompts));
        break;
      case "install":
        prompts.outro(await setupInstall(prompts));
        break;
      case "agent":
        prompts.outro(await setupAgentEnv(valueArg, prompts));
        break;
      case "bash":
        prompts.outro(await setupBash(prompts));
        break;
    }
  } catch (err) {
    if (err instanceof ConfigSetupCancelledError) {
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function resolveSetupModule(
  moduleArg: string | undefined,
  prompts: ConfigPromptAdapter,
): Promise<ConfigSetupModule> {
  if (moduleArg === undefined) {
    return prompts.select({
      message: "要配置哪一类内容？",
      options: [
        { value: "llm", label: "LLM", hint: "默认模型和 provider key" },
        { value: "install", label: "Install network", hint: "npm registry、重试和超时" },
        { value: "agent", label: "Agent env", hint: "配置某个 Agent 需要的环境变量" },
        { value: "bash", label: "Chat bash 工具", hint: "roll chat 内建 shell 执行能力（默认关闭）" },
      ],
    });
  }

  if (
    moduleArg === "llm" ||
    moduleArg === "install" ||
    moduleArg === "agent" ||
    moduleArg === "bash"
  ) {
    return moduleArg;
  }

  throw new Error(`未知 setup 模块: ${moduleArg}。可用: llm, install, agent, bash`);
}

export async function setupLlm(prompts: ConfigPromptAdapter): Promise<string> {
  const provider = await prompts.select<LlmProviderOption>({
    message: "选择默认 LLM provider",
    options: LLM_PROVIDER_OPTIONS.map((value) => ({
      value,
      label: value,
      hint: DEFAULT_LLM_MODELS[value],
    })),
    initialValue: DEFAULT_LLM_PROVIDER,
  });
  const model = await prompts.text({
    message: "默认 model",
    defaultValue: DEFAULT_LLM_MODELS[provider],
    required: true,
  });
  const apiKey = await prompts.password({
    message: `${provider} API key（可直接输入真实 key，也可输入 \${ENV_VAR}）`,
    required: true,
  });
  const baseUrl = await prompts.text({
    message: "自定义 base-url（可选，留空则不写）",
    required: false,
  });

  const context = readConfigDocumentContext();
  setYamlValue(context.document, ["llm", "defaultProvider"], provider);
  setYamlValue(context.document, ["llm", "defaultModel"], model);
  setYamlValue(context.document, ["llm", "providers", provider, "apiKey"], apiKey);
  if (baseUrl.trim().length > 0) {
    setYamlValue(context.document, ["llm", "providers", provider, "baseUrl"], baseUrl.trim());
  } else {
    deleteYamlValue(context.document, ["llm", "providers", provider, "baseUrl"]);
  }
  writeConfigDocument(context);
  warnIfPlaintextSecret(prompts, `${provider} API key`, apiKey);
  return `已配置 LLM: ${provider}/${model}（写入 ${context.configPath}）`;
}

export async function setupInstall(prompts: ConfigPromptAdapter): Promise<string> {
  const scenario = await prompts.select<InstallScenario>({
    message: "当前安装/更新网络更接近哪种场景？",
    options: [
      { value: "default-network", label: "默认网络 / 海外网络", hint: "不设置 registry" },
      {
        value: "china-dev",
        label: "国内开发机",
        hint: "使用 https://registry.npmmirror.com",
      },
      { value: "private-registry", label: "企业内网 / 私有 registry" },
      { value: "advanced", label: "高级自定义" },
    ],
  });

  const context = readConfigDocumentContext();
  switch (scenario) {
    case "default-network":
      setInstallDefaults(context.document);
      deleteYamlValue(context.document, ["install", "registry"]);
      break;
    case "china-dev":
      setInstallDefaults(context.document);
      setYamlValue(context.document, ["install", "registry"], "https://registry.npmmirror.com");
      break;
    case "private-registry": {
      const registry = await prompts.text({
        message: "私有 registry URL",
        placeholder: "https://registry.example.com",
        required: true,
      });
      setInstallDefaults(context.document);
      setYamlValue(context.document, ["install", "registry"], registry.trim());
      break;
    }
    case "advanced":
      await setupInstallAdvanced(context.document, prompts);
      break;
  }

  writeConfigDocument(context);
  return `已配置 install 网络参数（写入 ${context.configPath}）`;
}

export async function setupBash(prompts: ConfigPromptAdapter): Promise<string> {
  const enabled = await prompts.confirm({
    message:
      "启用 roll chat 内建 bash 工具（允许模型在本机执行 shell 命令，破坏性命令仍需逐条确认）？",
    initialValue: false,
  });
  let autoApproveSafe = true;
  let sessionEnabled = false;
  if (enabled) {
    autoApproveSafe = await prompts.confirm({
      message: "安全只读命令（ls/grep 等）自动放行，无需逐条确认？",
      initialValue: true,
    });
    sessionEnabled = await prompts.confirm({
      message: "启用长跑命令会话（session exec，供 dev server 等常驻进程使用）？",
      initialValue: false,
    });
  }

  const context = readConfigDocumentContext();
  setYamlValue(context.document, ["runtime", "bash", "enabled"], enabled);
  if (enabled) {
    setYamlValue(context.document, ["runtime", "bash", "autoApproveSafe"], autoApproveSafe);
    setYamlValue(context.document, ["runtime", "bash", "session", "enabled"], sessionEnabled);
  }
  writeConfigDocument(context);
  return `已${enabled ? "启用" : "禁用"} chat bash 工具（写入 ${context.configPath}）`;
}

async function setupInstallAdvanced(
  document: Record<string, unknown>,
  prompts: ConfigPromptAdapter,
): Promise<void> {
  const registry = await prompts.text({
    message: "npm registry（留空则不写）",
    placeholder: "https://registry.npmmirror.com",
  });
  const fetchRetries = await prompts.text({
    message: "fetch-retries",
    defaultValue: "3",
    required: true,
    validate: validateIntegerInRange(0, 10),
  });
  const preferOffline = await prompts.confirm({
    message: "是否启用 prefer-offline？",
    initialValue: false,
  });
  const networkTimeoutMs = await prompts.text({
    message: "network-timeout-ms",
    defaultValue: "120000",
    required: true,
    validate: validateIntegerInRange(10_000, Number.MAX_SAFE_INTEGER),
  });

  setYamlValue(document, ["install", "fetchRetries"], Number.parseInt(fetchRetries, 10));
  setYamlValue(document, ["install", "preferOffline"], preferOffline);
  setYamlValue(document, ["install", "networkTimeoutMs"], Number.parseInt(networkTimeoutMs, 10));
  if (registry.trim().length > 0) {
    setYamlValue(document, ["install", "registry"], registry.trim());
  } else {
    deleteYamlValue(document, ["install", "registry"]);
  }
}

export async function setupAgentEnv(
  agentNameArg: string | undefined,
  prompts: ConfigPromptAdapter,
): Promise<string> {
  const { agentsConfig } = loadAgentsConfig();
  const store = new AgentStore(agentsConfig.dataDir);
  const agent = await resolveAgentWithEnv(store.list(), agentNameArg, prompts);
  const report = inspectAgentEnvRequirements(agent.skill.name, agent.skill.env, agentsConfig.env);
  if (!report) {
    throw new Error(`Agent "${agent.skill.name}" 未声明环境变量需求。`);
  }

  const context = readConfigDocumentContext();
  const configuredEnv = agentsConfig.env?.[agent.skill.name] ?? {};
  const nextEnv: Record<string, string> = { ...configuredEnv };
  const declarations = flattenAgentEnvDeclarations(agent.skill.env);
  const reportItems = new Map(report.items.map((item) => [item.name, item]));

  for (const declaration of declarations.filter((item) => item.required)) {
    const reportItem = reportItems.get(declaration.name);
    const value = await promptAgentEnvValue(
      {
        declaration,
        yamlValue: nextEnv[declaration.name],
        source: reportItem?.source,
        processEnvValue: process.env[declaration.name],
      },
      prompts,
    );
    if (value !== undefined) {
      nextEnv[declaration.name] = value;
    }
  }

  const configureOptional = await prompts.confirm({
    message: "是否配置可选环境变量？",
    initialValue: false,
  });
  if (configureOptional) {
    for (const declaration of declarations.filter((item) => !item.required)) {
      const reportItem = reportItems.get(declaration.name);
      const value = await promptAgentEnvValue(
        {
          declaration,
          yamlValue: nextEnv[declaration.name],
          source: reportItem?.source,
          processEnvValue: process.env[declaration.name],
        },
        prompts,
      );
      if (value !== undefined) {
        nextEnv[declaration.name] = value;
      }
    }
  }

  setYamlValue(context.document, ["agents", "env", agent.skill.name], nextEnv);
  writeConfigDocument(context);
  for (const [name, value] of Object.entries(nextEnv)) {
    if (isSecretEnvName(name)) {
      warnIfPlaintextSecret(prompts, name, value);
    }
  }
  reportEnvActivation(prompts, agent);
  return `已配置 Agent 环境变量: ${agent.skill.name}（写入 ${context.configPath}）`;
}

async function resolveAgentWithEnv(
  agents: readonly RegisteredAgent[],
  agentNameArg: string | undefined,
  prompts: ConfigPromptAdapter,
): Promise<RegisteredAgent> {
  if (agentNameArg !== undefined) {
    const agent = agents.find((item) => item.skill.name === agentNameArg);
    if (!agent) {
      throw new Error(`Agent "${agentNameArg}" 未找到`);
    }
    if (!hasAgentEnvDeclarations(agent)) {
      throw new Error(`Agent "${agentNameArg}" 未声明环境变量需求。`);
    }
    return agent;
  }

  const candidates = agents.filter(hasAgentEnvDeclarations);
  if (candidates.length === 0) {
    throw new Error("没有已注册且声明环境变量需求的 Agent。");
  }

  const selectedName = await prompts.select({
    message: "选择要配置的 Agent",
    options: candidates.map(
      (agent): PromptOption<string> => ({
        value: agent.skill.name,
        label: agent.skill.name,
        hint: agent.skill.description,
      }),
    ),
  });
  const selected = candidates.find((agent) => agent.skill.name === selectedName);
  if (!selected) {
    throw new Error(`Agent "${selectedName}" 未找到`);
  }
  return selected;
}

function hasAgentEnvDeclarations(agent: RegisteredAgent): boolean {
  return flattenAgentEnvDeclarations(agent.skill.env).length > 0;
}

interface AgentEnvPromptInput {
  readonly declaration: ReturnType<typeof flattenAgentEnvDeclarations>[number];
  readonly yamlValue: string | undefined;
  readonly source: AgentEnvCheckItem["source"] | undefined;
  readonly processEnvValue: string | undefined;
}

async function promptAgentEnvValue(
  input: AgentEnvPromptInput,
  prompts: ConfigPromptAdapter,
): Promise<string | undefined> {
  const { declaration, processEnvValue, source, yamlValue } = input;
  const hasPersistedValue = source === "agents.env" && isResolvedEnvValue(yamlValue);
  const labelDetails = [
    declaration.required ? "必填" : "可选",
    hasPersistedValue ? "回车保留当前值" : undefined,
  ]
    .filter((item): item is string => item !== undefined)
    .join("，");
  const label = `${declaration.name}（${labelDetails}）`;
  const details = [
    declaration.purpose ? `用途: ${declaration.purpose}` : undefined,
    declaration.example ? `示例: ${declaration.example}` : undefined,
    declaration.default ? `默认: ${declaration.default}` : undefined,
    hasPersistedValue ? "当前 YAML 已配置，回车保留当前值。" : undefined,
    yamlValue !== undefined && !hasPersistedValue
      ? "当前 YAML 值为空或占位符未解析，会被视为缺失。"
      : undefined,
    source === "process.env" ? "当前来源: 当前 shell 临时环境变量，尚未持久写入 YAML。" : undefined,
  ]
    .filter((item): item is string => item !== undefined)
    .join("\n");
  if (details.length > 0) {
    prompts.info(details);
  }

  if (
    source === "process.env" &&
    typeof processEnvValue === "string" &&
    processEnvValue.length > 0
  ) {
    const persistShellValue = await prompts.confirm({
      message: `是否将 ${declaration.name} 的当前 shell 值写入 roll.config.yaml？`,
      initialValue: true,
    });
    if (persistShellValue) {
      return processEnvValue;
    }
  }

  const required =
    declaration.required &&
    !hasPersistedValue &&
    declaration.default === undefined &&
    source !== "process.env";
  const promptOptions = {
    message: label,
    ...(hasPersistedValue && yamlValue !== undefined ? { defaultValue: yamlValue } : {}),
    ...(declaration.example !== undefined ? { placeholder: declaration.example } : {}),
    required,
  };
  const value = isSecretEnvName(declaration.name)
    ? await prompts.password({ message: label, required })
    : await prompts.text(promptOptions);

  if (value.trim().length === 0) {
    return hasPersistedValue ? yamlValue : undefined;
  }
  return value;
}

function setInstallDefaults(document: Record<string, unknown>): void {
  setYamlValue(document, ["install", "fetchRetries"], DEFAULT_CONFIG.install.fetchRetries);
  setYamlValue(document, ["install", "preferOffline"], DEFAULT_CONFIG.install.preferOffline);
  setYamlValue(document, ["install", "networkTimeoutMs"], DEFAULT_CONFIG.install.networkTimeoutMs);
}

function readConfigDocumentContext(): ConfigDocumentContext {
  const existingConfigPath = resolveConfigPath();
  const configPath = existingConfigPath ?? resolve(homedir(), "roll.config.yaml");
  if (existingConfigPath === undefined || !existsSync(configPath)) {
    return {
      configPath,
      existed: false,
      document: buildBaseConfigDocument(),
    };
  }

  const raw = readFileSync(configPath, "utf-8");
  return {
    configPath,
    existed: true,
    raw,
    document: parseConfigDocument(raw, configPath),
  };
}

function buildBaseConfigDocument(): Record<string, unknown> {
  return {
    llm: {
      "default-provider": DEFAULT_CONFIG.llm.defaultProvider,
      "default-model": DEFAULT_CONFIG.llm.defaultModel,
      providers: {},
    },
    ask: {},
    agents: {
      "data-dir": DEFAULT_CONFIG.agents.dataDir,
    },
  };
}

function writeConfigDocument(context: ConfigDocumentContext): void {
  const nextYaml = stringifyYaml(context.document, { lineWidth: 0 });
  validateConfigText(nextYaml, context.configPath);
  if (context.existed && context.raw !== undefined) {
    writeFileSync(buildBackupPath(context.configPath), context.raw, "utf-8");
  }
  writeFileSync(context.configPath, nextYaml, "utf-8");
}

function buildBackupPath(configPath: string): string {
  const now = new Date();
  const timestamp = [
    now.getFullYear().toString().padStart(4, "0"),
    (now.getMonth() + 1).toString().padStart(2, "0"),
    now.getDate().toString().padStart(2, "0"),
    "-",
    now.getHours().toString().padStart(2, "0"),
    now.getMinutes().toString().padStart(2, "0"),
    now.getSeconds().toString().padStart(2, "0"),
  ].join("");
  return `${configPath}.bak.${timestamp}`;
}

function setYamlValue(
  document: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  const yamlPath = encodePathToYaml(path);
  const leaf = yamlPath[yamlPath.length - 1];
  if (leaf === undefined) {
    throw new Error("配置路径不能为空");
  }

  let current = document;
  for (const segment of yamlPath.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[leaf] = value;
}

function deleteYamlValue(document: Record<string, unknown>, path: readonly string[]): void {
  const yamlPath = encodePathToYaml(path);
  const leaf = yamlPath[yamlPath.length - 1];
  if (leaf === undefined) {
    return;
  }

  let current: unknown = document;
  for (const segment of yamlPath.slice(0, -1)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    delete (current as Record<string, unknown>)[leaf];
  }
}

function validateIntegerInRange(min: number, max: number): (value: string) => string | undefined {
  return (value: string) => {
    if (!/^\d+$/u.test(value)) {
      return "请输入整数";
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed < min || parsed > max) {
      return `请输入 ${String(min)} 到 ${String(max)} 之间的整数`;
    }
    return undefined;
  };
}

function isResolvedEnvValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !ENV_PLACEHOLDER_PATTERN.test(value);
}

function warnIfPlaintextSecret(prompts: ConfigPromptAdapter, label: string, value: string): void {
  if (value.trim().length === 0 || ENV_PLACEHOLDER_PATTERN.test(value)) {
    return;
  }
  prompts.warn(
    `${label} 将以明文写入 roll.config.yaml，建议改用 ${"$"}{ENV_VAR} 引用并避免把配置文件提交到版本库。`,
  );
}

function reportEnvActivation(prompts: ConfigPromptAdapter, agent: RegisteredAgent): void {
  const name = agent.skill.name;
  switch (agent.runtime.ownership) {
    case "core-managed":
      prompts.info(`需重启后生效：roll agent stop ${name} && roll agent start ${name}`);
      break;
    case "external-managed":
      prompts.info(`请重启你自行管理的 "${name}" 进程以加载新环境变量。`);
      break;
    case "on-demand":
      prompts.info(`下次 roll run / roll ask 调用 "${name}" 时自动生效。`);
      break;
  }
}
