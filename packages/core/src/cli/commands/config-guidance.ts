import { DEFAULT_CONFIG } from "../../config/defaults.ts";
import { normalizeUserPath } from "../../config/key-codec.ts";
import type { AgentEnvDeclaration, AgentSkillEnvDeclarations } from "../../types/agent.ts";

export const INSTALL_SCENARIOS = [
  "default-network",
  "china-dev",
  "private-registry",
  "advanced",
] as const;
export type InstallScenario = (typeof INSTALL_SCENARIOS)[number];

export interface ConfigGuidanceEntry {
  readonly path: string;
  readonly title: string;
  readonly purpose: string;
  readonly defaultBehavior?: string;
  readonly example?: string;
  readonly setupCommand?: string;
}

export const CONFIG_GUIDANCE_ENTRIES = [
  {
    path: "llm.default-provider",
    title: "默认 LLM Provider",
    purpose: "`roll ask` / `roll chat` 默认使用的模型提供商。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.llm.defaultProvider}\`。`,
    example: `llm:\n  default-provider: ${DEFAULT_CONFIG.llm.defaultProvider}`,
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.default-model",
    title: "默认 LLM Model",
    purpose: "`roll ask` / `roll chat` 默认使用的模型名称。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.llm.defaultModel}\`。`,
    example: `llm:\n  default-model: ${DEFAULT_CONFIG.llm.defaultModel}`,
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers.<provider>.api-key",
    title: "Provider API Key",
    purpose:
      "指定 LLM provider 的 API key。可以写真实 key，也可以写 `" + "$" + "{ENV_VAR}` 占位符。",
    example: "llm:\n  providers:\n    anthropic:\n      api-key: $" + "{ANTHROPIC_API_KEY}",
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers.<provider>.base-url",
    title: "Provider Base URL",
    purpose: "指定 LLM provider 的自定义 API base URL，通常只在代理、兼容网关或私有部署时需要。",
    defaultBehavior: "不配置时使用 provider SDK 默认地址。",
    example: "llm:\n  providers:\n    openai:\n      base-url: https://api.openai.com/v1",
    setupCommand: "roll config setup llm",
  },
  {
    path: "install.registry",
    title: "npm Registry",
    purpose: "`roll agent install` / `roll update` 查询和安装 npm 包时使用的 registry。",
    defaultBehavior: "不配置时走 npm 自身默认源；Roll 不做隐式镜像 fallback。",
    example: "install:\n  registry: https://registry.npmmirror.com",
    setupCommand: "roll config setup install",
  },
  {
    path: "install.fetch-retries",
    title: "npm Fetch Retries",
    purpose: "透传给 npm 的 `--fetch-retries`，同时影响 Roll 层整体网络重试次数。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.install.fetchRetries}\`。`,
    example: `install:\n  fetch-retries: ${DEFAULT_CONFIG.install.fetchRetries}`,
    setupCommand: "roll config setup install",
  },
  {
    path: "install.prefer-offline",
    title: "Prefer Offline",
    purpose: "安装时是否附加 `--prefer-offline`。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.install.preferOffline}\`，避免更新时复用过期 npm 元数据。`,
    example: `install:\n  prefer-offline: ${DEFAULT_CONFIG.install.preferOffline}`,
    setupCommand: "roll config setup install",
  },
  {
    path: "install.network-timeout-ms",
    title: "Install Network Timeout",
    purpose: "单次 npm install 命令的超时时间，单位毫秒。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.install.networkTimeoutMs}\`，即 120 秒。`,
    example: `install:\n  network-timeout-ms: ${DEFAULT_CONFIG.install.networkTimeoutMs}`,
    setupCommand: "roll config setup install",
  },
  {
    path: "agents.data-dir",
    title: "Agent 数据目录",
    purpose: "Roll 持久化已注册 Agent、PID、日志和 runtime sidecar 的目录。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.agents.dataDir}\`。`,
    example: `agents:\n  data-dir: ${DEFAULT_CONFIG.agents.dataDir}`,
  },
  {
    path: "agents.env.<agent-name>",
    title: "Agent 环境变量",
    purpose: "按 Agent 名称声明注入到子 Agent 进程的环境变量。",
    defaultBehavior:
      "未配置时只会继承当前 shell 环境变量；core-managed Agent 需要重启才会看到新值。",
    example:
      "agents:\n  env:\n    browser-use-agent:\n      REPLY_AUTHORITY_URL: https://example.com",
    setupCommand: "roll config setup agent <agent-name>",
  },
  {
    path: "ask.confirm-threshold",
    title: "Ask 确认阈值",
    purpose: "`roll ask` 路由置信度低于该阈值时，倾向要求用户确认。",
    defaultBehavior: "未配置时使用内置路由默认行为。",
    example: "ask:\n  confirm-threshold: 0.5",
  },
  {
    path: "runtime.approval.default",
    title: "Chat 工具确认默认策略",
    purpose:
      "`roll chat` 调用工具时的默认确认策略。`guarded` 使用内置读写启发式，`auto` 默认放行非破坏性工具，`deny` 默认拒绝。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.approval.default}\`。此配置不影响 \`roll ask\`。`,
    example: `runtime:\n  approval:\n    default: ${DEFAULT_CONFIG.runtime.approval.default}`,
  },
  {
    path: "runtime.approval.overrides",
    title: "Chat 工具确认精确覆盖",
    purpose:
      "`roll chat` 按完整 `agentName.toolName` 覆盖单个工具的确认策略。可选值为 `auto`、`confirm`、`deny`。",
    defaultBehavior: "未配置时回退到 `runtime.approval.default`。",
    example:
      "runtime:\n  approval:\n    overrides:\n      browser-use-agent.zhipin_send_prepared_reply: confirm\n      browser-use-agent.browser_status: auto",
  },
  {
    path: "runtime.shell.enabled",
    title: "Chat 内建 shell 工具",
    purpose:
      "开启后 `roll chat` 注册内建 shell 工具：macOS/Linux 为 `roll__bash`，Windows 原生为 `roll__powershell`（需 PowerShell 7+）。命令继承 roll 进程环境变量；默认确认策略可由 `runtime.approval` 及精确 override 覆盖。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.shell.enabled)}\`（关闭）。Windows 未检测到 pwsh 7+ 时会跳过注册。`,
    example: "runtime:\n  shell:\n    enabled: true",
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.auto-approve-safe",
    title: "只读命令免确认",
    purpose:
      "开启后用内建规则分类器识别 POSIX known-safe 只读命令（如 `ls`、`cat`、`git status`），在 `guarded`/`auto` 策略下免确认执行；dangerous（`rm -rf`、`sudo`）与无法识别的命令默认仍需确认。工具级显式 approval override 优先；Windows PowerShell 当前全部按 unknown 处理。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.shell.autoApproveSafe)}\`。关闭后 POSIX 回归默认逐条确认；Windows PowerShell 默认逐条确认，显式 approval override 可覆盖。`,
    example: "runtime:\n  shell:\n    enabled: true\n    auto-approve-safe: false",
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.session.enabled",
    title: "Chat 会话式长命令执行",
    purpose:
      "开启后在 POSIX shell 后端注册 `roll__exec_command` + `roll__exec_poll` 工具：命令在后台会话执行、跨轮存活，模型轮询进度并读取退出码，适合超过单轮超时的长脚本。Windows 原生 session exec 暂未支持。仅交互 REPL 与 `--server` 长驻模式注册（单条消息 / `--json` 单轮会话随进程结束，不提供该工具）；`--server` 下 `exec_command` 需 `runtime.approval.overrides` 里 `roll.exec_command: auto` 显式授权。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.shell.session.enabled)}\`（关闭）。需同时开启 runtime.shell.enabled；背景会话随 roll chat 进程退出而终止。`,
    example:
      "runtime:\n  shell:\n    enabled: true\n    session:\n      enabled: true\n  approval:\n    overrides:\n      roll.exec_command: auto",
    setupCommand: "roll config setup shell",
  },
  {
    path: "skills.dirs",
    title: "Chat 额外 skill 目录",
    purpose:
      "`roll chat` 除自动发现项目与用户级 `.agents/skills`（`npx skills add` 的标准安装位置）及已注册 Agent 的 SKILL.md 外，额外加载的 skill 目录。目录可以直接包含 SKILL.md，也可以是多个 skill 子目录的集合。",
    defaultBehavior:
      "默认为空。标准路径 `<项目>/.agents/skills` 与 `~/.agents/skills` 始终自动发现。",
    example: "skills:\n  dirs:\n    - ./openclaw-roll-core-skill-template",
  },
  {
    path: "browser.default-instance",
    title: "默认浏览器实例",
    purpose: "多浏览器实例配置下，未显式指定 browserInstance 时使用的默认实例。",
    defaultBehavior: "不配置且只有一个实例时可自动推断；多个实例时工具可能返回 needs_input。",
    example: "browser:\n  default-instance: boss-a",
  },
  {
    path: "browser.instances",
    title: "浏览器实例声明",
    purpose: "声明 browser-use-agent 可使用的浏览器 profile、CDP 端口、会话目录和业务归因信息。",
    defaultBehavior: "不配置时 browser-use-agent 使用 legacy 单实例环境变量路径。",
    example:
      "browser:\n  instances:\n    boss-a:\n      platform: zhipin\n      mode: managed-cdp\n      cdp-port: 9222\n      user-data-dir: ~/.roll-agent/browser/boss-a",
  },
] as const satisfies readonly ConfigGuidanceEntry[];

export function listConfigGuidanceEntries(): readonly ConfigGuidanceEntry[] {
  return CONFIG_GUIDANCE_ENTRIES;
}

export function findConfigGuidance(path: string): ConfigGuidanceEntry | undefined {
  const normalizedPath = normalizeUserPath(path.split(".")).join(".");
  return CONFIG_GUIDANCE_ENTRIES.find((entry) => matchesGuidancePath(entry.path, normalizedPath));
}

function matchesGuidancePath(pattern: string, normalizedPath: string): boolean {
  const normalizedPattern = normalizeUserPath(pattern.split(".")).join(".");
  if (normalizedPattern === normalizedPath) {
    return true;
  }

  const patternParts = normalizedPattern.split(".");
  const pathParts = normalizedPath.split(".");
  if (patternParts.length !== pathParts.length) {
    return false;
  }

  return patternParts.every((part, index) => part.startsWith("<") || part === pathParts[index]);
}

export function flattenAgentEnvDeclarations(
  declarations: AgentSkillEnvDeclarations | undefined,
): ReadonlyArray<AgentEnvDeclaration & { readonly required: boolean }> {
  return [
    ...(declarations?.required ?? []).map((item) => ({ ...item, required: true })),
    ...(declarations?.optional ?? []).map((item) => ({ ...item, required: false })),
  ];
}

export function isSecretEnvName(name: string): boolean {
  return /(?:TOKEN|KEY|SECRET|PASSWORD)/iu.test(name);
}
