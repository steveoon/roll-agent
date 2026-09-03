import { isDeepStrictEqual } from "node:util";
import {
  ConfigApplicationService,
  createConfigPatches,
  type ConfigApplicationSnapshot,
} from "../../config/application-service.ts";
import {
  ConfigRevisionConflictError,
  type ConfigPatch,
  type ConfigPath,
} from "../../config/document-store.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_LLM_MODELS,
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDER_OPTIONS,
  type LlmProviderOption,
} from "../../config/defaults.ts";
import { inspectAgentEnvRequirements, type AgentEnvCheckItem } from "../../config/helpers.ts";
import { decodeFromYaml } from "../../config/key-codec.ts";
import { loadAgentsConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import type { RegisteredAgent } from "../../types/agent.ts";
import {
  flattenAgentEnvDeclarations,
  isSecretEnvDeclaration,
  type InstallScenario,
} from "../../config/guidance.ts";
import {
  ConfigSetupCancelledError,
  clackPromptAdapter,
  type ConfigPromptAdapter,
  type PromptOption,
} from "./config-prompts.ts";

export type ConfigSetupModule = "llm" | "install" | "agent" | "shell";

const ENV_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/u;

interface ConfigDocumentContext {
  readonly configPath: string;
  readonly existed: boolean;
  readonly document: Record<string, unknown>;
  readonly basePersisted: Readonly<Record<string, unknown>>;
  readonly snapshot: ConfigApplicationSnapshot;
  readonly service: ConfigApplicationService;
}

interface AdvancedInstallSetupValues {
  readonly registry: string;
  readonly fetchRetries: number;
  readonly preferOffline: boolean;
  readonly networkTimeoutMs: number;
}

type InstallSetupValues =
  | {
      readonly scenario: Exclude<InstallScenario, "private-registry" | "advanced">;
    }
  | {
      readonly scenario: Extract<InstallScenario, "private-registry">;
      readonly registry: string;
    }
  | {
      readonly scenario: Extract<InstallScenario, "advanced">;
      readonly values: AdvancedInstallSetupValues;
    };

export async function runConfigSetup(
  moduleArg: string | undefined,
  valueArg: string | undefined,
  prompts: ConfigPromptAdapter = clackPromptAdapter,
): Promise<void> {
  try {
    prompts.intro("Roll 配置向导");
    readConfigDocumentContext();
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
      case "shell":
        prompts.outro(await setupShell(prompts));
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
        {
          value: "shell",
          label: "Chat shell 工具",
          hint: "roll chat 内建本机命令执行能力（默认关闭）",
        },
      ],
    });
  }

  if (
    moduleArg === "llm" ||
    moduleArg === "install" ||
    moduleArg === "agent" ||
    moduleArg === "shell"
  ) {
    return moduleArg;
  }
  if (moduleArg === "bash") {
    return "shell";
  }

  throw new Error(`未知 setup 模块: ${moduleArg}。可用: llm, install, agent, shell`);
}

export async function setupLlm(prompts: ConfigPromptAdapter): Promise<string> {
  const context = readConfigDocumentContext();
  const provider = await prompts.select<LlmProviderOption>({
    message: "选择默认 LLM provider",
    options: LLM_PROVIDER_OPTIONS.map((value) => ({
      value,
      label: `${value} · ${LLM_PROVIDER_LABELS[value]}`,
      hint: `默认模型 ${DEFAULT_LLM_MODELS[value]}`,
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
  const context = readConfigDocumentContext();
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

  const setupValues = await collectInstallSetupValues(scenario, prompts);
  switch (setupValues.scenario) {
    case "default-network":
      setInstallDefaults(context.document);
      deleteYamlValue(context.document, ["install", "registry"]);
      break;
    case "china-dev":
      setInstallDefaults(context.document);
      setYamlValue(context.document, ["install", "registry"], "https://registry.npmmirror.com");
      break;
    case "private-registry":
      setInstallDefaults(context.document);
      setYamlValue(context.document, ["install", "registry"], setupValues.registry);
      break;
    case "advanced": {
      const { registry, fetchRetries, preferOffline, networkTimeoutMs } = setupValues.values;
      setYamlValue(context.document, ["install", "fetchRetries"], fetchRetries);
      setYamlValue(context.document, ["install", "preferOffline"], preferOffline);
      setYamlValue(context.document, ["install", "networkTimeoutMs"], networkTimeoutMs);
      if (registry.length > 0) {
        setYamlValue(context.document, ["install", "registry"], registry);
      } else {
        deleteYamlValue(context.document, ["install", "registry"]);
      }
      break;
    }
  }

  writeConfigDocument(context);
  return `已配置 install 网络参数（写入 ${context.configPath}）`;
}

export async function setupShell(
  prompts: ConfigPromptAdapter,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const context = readConfigDocumentContext();
  const enabled = await prompts.confirm({
    message:
      "启用 roll chat 内建 shell 工具（允许模型在本机执行命令；默认确认策略受 runtime.approval 及显式 override 控制）？",
    initialValue: false,
  });
  let autoApproveSafe = true;
  let sessionEnabled = false;
  const isWindows = platform === "win32";
  if (enabled && isWindows) {
    prompts.warn(
      "Windows PowerShell 命令当前全部按 unknown 处理，默认每条命令都需确认；显式 approval override（roll.powershell: auto、roll.exec_command: auto）可覆盖对应工具的默认策略。",
    );
  }
  if (enabled && !isWindows) {
    autoApproveSafe = await prompts.confirm({
      message: "安全只读命令（ls/grep 等）自动放行，无需逐条确认？",
      initialValue: true,
    });
  }
  if (enabled) {
    sessionEnabled = await prompts.confirm({
      message: "启用长跑命令会话（session exec，供 dev server 等常驻进程使用）？",
      initialValue: false,
    });
  }

  setYamlValue(context.document, ["runtime", "shell", "enabled"], enabled);
  if (enabled && !isWindows) {
    setYamlValue(context.document, ["runtime", "shell", "autoApproveSafe"], autoApproveSafe);
  }
  if (enabled) {
    setYamlValue(context.document, ["runtime", "shell", "session", "enabled"], sessionEnabled);
  }
  writeConfigDocument(context);
  const windowsNote =
    enabled && isWindows
      ? "；Windows PowerShell 默认逐条确认（显式 approval override 可覆盖）"
      : "";
  return `已${enabled ? "启用" : "禁用"} chat shell 工具${windowsNote}（写入 ${context.configPath}）`;
}

export async function setupBash(prompts: ConfigPromptAdapter): Promise<string> {
  return setupShell(prompts);
}

async function collectInstallSetupValues(
  scenario: InstallScenario,
  prompts: ConfigPromptAdapter,
): Promise<InstallSetupValues> {
  switch (scenario) {
    case "default-network":
    case "china-dev":
      return { scenario };
    case "private-registry": {
      const registry = await prompts.text({
        message: "私有 registry URL",
        placeholder: "https://registry.example.com",
        required: true,
      });
      return { scenario, registry: registry.trim() };
    }
    case "advanced":
      return { scenario, values: await setupInstallAdvanced(prompts) };
  }
}

async function setupInstallAdvanced(
  prompts: ConfigPromptAdapter,
): Promise<AdvancedInstallSetupValues> {
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

  return {
    registry: registry.trim(),
    fetchRetries: Number.parseInt(fetchRetries, 10),
    preferOffline,
    networkTimeoutMs: Number.parseInt(networkTimeoutMs, 10),
  };
}

export async function setupAgentEnv(
  agentNameArg: string | undefined,
  prompts: ConfigPromptAdapter,
): Promise<string> {
  const context = readConfigDocumentContext();
  const { agentsConfig } = loadAgentsConfig();
  const store = new AgentStore(agentsConfig.dataDir);
  const agent = await resolveAgentWithEnv(store.list(), agentNameArg, prompts);
  const report = inspectAgentEnvRequirements(agent.skill.name, agent.skill.env, agentsConfig.env);
  if (!report) {
    throw new Error(`Agent "${agent.skill.name}" 未声明环境变量需求。`);
  }

  const configuredEnv = getPersistedAgentEnv(context.document, agent.skill.name);
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
    const declaration = declarations.find((item) => item.name === name);
    if (declaration !== undefined && isSecretEnvDeclaration(declaration)) {
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
  const hasPersistedValue = isPersistedEnvValue(yamlValue);
  const hasUnresolvedPlaceholder = hasPersistedValue && ENV_PLACEHOLDER_PATTERN.test(yamlValue);
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
    hasPersistedValue
      ? hasUnresolvedPlaceholder
        ? "当前 YAML 使用环境变量占位符，回车会原样保留。"
        : "当前 YAML 已配置，回车保留当前值。"
      : undefined,
    hasUnresolvedPlaceholder && source !== "agents.env"
      ? "当前占位符未解析，运行时仍会把该值视为缺失。"
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
  const value = isSecretEnvDeclaration(declaration)
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
  const service = new ConfigApplicationService();
  const snapshot = service.readForRepair();
  const internalSnapshot = readInternalConfigSnapshot(service);
  if (snapshot.revision !== internalSnapshot.revision) {
    throw new ConfigRevisionConflictError(snapshot.revision, internalSnapshot.revision);
  }
  return {
    configPath: snapshot.configPath,
    existed: snapshot.existed,
    document: cloneConfigRecord(snapshot.persisted),
    basePersisted: internalSnapshot.persisted,
    snapshot,
    service,
  };
}

function writeConfigDocument(context: ConfigDocumentContext): void {
  const patches = createConfigPatches(context.snapshot.persisted, context.document);
  const latest = readInternalConfigSnapshot(context.service);
  assertTouchedPathsUnchanged(
    context.basePersisted,
    latest.persisted,
    patches,
    context.snapshot.revision,
    latest.revision,
  );
  context.service.savePatches(patches, latest.revision);
}

function readInternalConfigSnapshot(service: ConfigApplicationService): {
  readonly revision: ConfigApplicationSnapshot["revision"];
  readonly persisted: Readonly<Record<string, unknown>>;
} {
  const snapshot = service.store.read();
  const persisted = decodeFromYaml(snapshot.persisted);
  if (!isRecord(persisted)) {
    throw new Error(`配置内容必须是 object: ${snapshot.configPath}`);
  }
  return { revision: snapshot.revision, persisted };
}

function assertTouchedPathsUnchanged(
  base: Readonly<Record<string, unknown>>,
  latest: Readonly<Record<string, unknown>>,
  patches: readonly ConfigPatch[],
  expectedRevision: ConfigApplicationSnapshot["revision"],
  actualRevision: ConfigApplicationSnapshot["revision"],
): void {
  for (const patch of patches) {
    const baseValue = readConfigPath(base, patch.path);
    const latestValue = readConfigPath(latest, patch.path);
    if (
      baseValue.exists !== latestValue.exists ||
      !isDeepStrictEqual(baseValue.value, latestValue.value)
    ) {
      throw new ConfigRevisionConflictError(expectedRevision, actualRevision);
    }
  }
}

function readConfigPath(
  root: Readonly<Record<string, unknown>>,
  path: ConfigPath,
): { readonly exists: boolean; readonly value: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !(segment in current)) {
        return { exists: false, value: undefined };
      }
      current = current[segment];
      continue;
    }
    if (!isRecord(current) || !(segment in current)) {
      return { exists: false, value: undefined };
    }
    current = current[segment];
  }
  return { exists: true, value: current };
}

function setYamlValue(
  document: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  const leaf = path[path.length - 1];
  if (leaf === undefined) {
    throw new Error("配置路径不能为空");
  }

  let current = document;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[leaf] = value;
}

function deleteYamlValue(document: Record<string, unknown>, path: readonly string[]): void {
  const leaf = path[path.length - 1];
  if (leaf === undefined) {
    return;
  }

  let current: unknown = document;
  for (const segment of path.slice(0, -1)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    delete (current as Record<string, unknown>)[leaf];
  }
}

function getPersistedAgentEnv(
  document: Readonly<Record<string, unknown>>,
  agentName: string,
): Record<string, string> {
  const agents = document["agents"];
  const env = isRecord(agents) ? agents["env"] : undefined;
  const configured = isRecord(env) ? env[agentName] : undefined;
  if (!isRecord(configured)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(configured).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function cloneConfigRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneConfigValue(child)]),
  );
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneConfigValue);
  }
  return isRecord(value) ? cloneConfigRecord(value) : value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isPersistedEnvValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
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
