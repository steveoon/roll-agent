import type { AgentEnvDeclaration, AgentSkillEnvDeclarations } from "../types/agent.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { normalizeUserPath } from "./key-codec.ts";

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
  // LLM
  {
    path: "llm",
    title: "LLM 与模型",
    purpose: "集中设置 Roll 默认使用的模型提供商、模型名称和各 Provider 连接信息。",
    defaultBehavior: "默认使用内置的 Anthropic Provider 与默认模型；实际调用仍需要可用的认证信息。",
    example: `llm:\n  default-provider: ${DEFAULT_CONFIG.llm.defaultProvider}\n  default-model: ${DEFAULT_CONFIG.llm.defaultModel}\n  providers: {}`,
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.default-provider",
    title: "默认 LLM 提供商",
    purpose:
      "选择 `roll ask`、`roll run` 的 MCP sampling，以及未单独覆盖时 `roll chat` 使用的模型提供商。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.llm.defaultProvider}\`。`,
    example: `llm:\n  default-provider: ${DEFAULT_CONFIG.llm.defaultProvider}`,
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.default-model",
    title: "默认 LLM 模型",
    purpose:
      "指定 Ask 的默认路由与 sampling 模型、Run 的 sampling 模型，以及 Chat 未单独覆盖时的模型。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.llm.defaultModel}\`。`,
    example: `llm:\n  default-model: ${DEFAULT_CONFIG.llm.defaultModel}`,
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers",
    title: "LLM Provider 配置",
    purpose: "按 Provider 名称保存认证密钥和可选的自定义 API 地址。",
    defaultBehavior: "默认没有 Provider 连接条目；只需添加实际会使用的 Provider。",
    example: "llm:\n  providers:\n    anthropic:\n      api-key: $" + "{ANTHROPIC_API_KEY}",
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers.<provider>",
    title: "单个 LLM Provider",
    purpose: "配置一个由名称标识的模型服务连接，例如 `anthropic`、`openai` 或兼容网关。",
    defaultBehavior: "新增条目后必须提供 API 密钥；API 地址可留空并使用 Provider 默认值。",
    example: "llm:\n  providers:\n    openai:\n      api-key: $" + "{OPENAI_API_KEY}",
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers.<provider>.api-key",
    title: "Provider API 密钥",
    purpose:
      "为一个 LLM provider 提供 API key（认证密钥）；推荐使用 `" +
      "$" +
      "{ENV_VAR}` 引用，避免明文落盘。",
    defaultBehavior: "无默认值；新增 provider 配置后必须填写，否则配置校验失败。",
    example: "llm:\n  providers:\n    anthropic:\n      api-key: $" + "{ANTHROPIC_API_KEY}",
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers.<provider>.base-url",
    title: "Provider API 地址",
    purpose: "把指定 provider 指向代理、兼容网关或私有部署的 API 根地址。",
    defaultBehavior: "不配置时使用各 provider 的内置地址；Qwen 使用 DashScope OpenAI 兼容地址。",
    example: "llm:\n  providers:\n    openai:\n      base-url: https://api.openai.com/v1",
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers.<provider>.models",
    title: "Provider 可选模型",
    purpose:
      "列出该 provider 下可在 roll chat 里用 /model 切换的模型 ID。定时任务等无人值守场景不受影响，始终使用默认模型。",
    defaultBehavior:
      "不配置时 /model 只显示该 provider 的内置默认模型，以及它作为 llm.default-provider 时的 llm.default-model。",
    example:
      "llm:\n  providers:\n    google:\n      models:\n        - gemini-3.8-flash\n        - gemini-3.1-pro-preview",
    setupCommand: "roll config setup llm",
  },
  {
    path: "llm.providers.<provider>.models.<item>",
    title: "可选模型 ID",
    purpose: "单个模型 ID，需与该 provider API 接受的模型名一致。",
    defaultBehavior: "列表为空时不产生额外候选。",
    example: "llm:\n  providers:\n    google:\n      models:\n        - gemini-3.8-flash",
    setupCommand: "roll config setup llm",
  },

  // Ask
  {
    path: "ask",
    title: "Ask 智能路由",
    purpose: "只覆盖 `roll ask` 的路由模型和低置信度确认阈值。",
    defaultBehavior: "不设置覆盖时沿用全局 LLM 模型与内置确认阈值。",
    example: "ask:\n  confirm-threshold: 0.5",
  },
  {
    path: "ask.llm-model",
    title: "Ask 路由模型",
    purpose: "仅为 `roll ask` 的意图路由和参数提取指定模型，不改变 `roll chat` 模型。",
    defaultBehavior: "不配置时使用 `llm.default-model`。",
    example: "ask:\n  llm-model: gpt-5.4-mini",
  },
  {
    path: "ask.confirm-threshold",
    title: "Ask 执行阈值",
    purpose: "路由置信度低于此值时停止自动执行，并返回需要确认的结果。",
    defaultBehavior: "不配置时使用内置阈值 `0.5`。",
    example: "ask:\n  confirm-threshold: 0.5",
  },

  // Chat presentation
  {
    path: "chat",
    title: "Chat 终端界面",
    purpose: "控制 `roll chat` 交互会话使用全屏 TUI 还是基础 REPL。",
    defaultBehavior: "默认自动判断终端能力与运行环境。",
    example: `chat:\n  screen-mode: ${DEFAULT_CONFIG.chat.screenMode}`,
  },
  {
    path: "chat.screen-mode",
    title: "Chat 界面模式",
    purpose: "选择 `auto` 自动检测、`fullscreen` 强制全屏 TUI，或 `inline` 使用基础 REPL。",
    defaultBehavior:
      "默认值为 `auto`；普通交互终端使用全屏，CI、无 ANSI 能力、screen reader、Zellij 和 tmux control mode 回退基础 REPL。",
    example: `chat:\n  screen-mode: ${DEFAULT_CONFIG.chat.screenMode}`,
  },
  {
    path: "chat.thinking-display",
    title: "思考内容展示",
    purpose:
      "控制全屏 TUI 中已完成的思考内容默认折叠为一行摘要（时长与字数），还是始终完整显示；思考进行中始终实时展示。",
    defaultBehavior:
      "默认值为 `collapsed`；会话内可用 `/show-think` 临时切换。基础 REPL 不渲染思考内容，不受此项影响。",
    example: `chat:\n  thinking-display: ${DEFAULT_CONFIG.chat.thinkingDisplay}`,
  },
  {
    path: "chat.instructions",
    title: "工作区工程约定注入",
    purpose:
      "控制 `roll chat` 是否把工作区的 AGENTS.md / CLAUDE.md 作为工程约定注入 system prompt：`auto` 从工作目录逐级向上找最近一层（同目录 AGENTS.md 优先），`off` 关闭，其他值视为约定文件路径（相对工作目录，支持 `~`）。",
    defaultBehavior:
      "默认值为 `auto`；找不到文件时不注入也不提示。文件超过 32000 字符会被截断并在 stderr 提示一次；每轮开始按修改时间检查变化。",
    example: `chat:\n  instructions: ${DEFAULT_CONFIG.chat.instructions}`,
  },

  // Chat runtime
  {
    path: "runtime",
    title: "Chat 运行时",
    purpose: "控制 `roll chat` 的模型、单轮限制、审批、上下文压缩和 Shell 工具。",
    defaultBehavior: "所有子项都有安全默认值；只有需要覆盖默认行为时才写入配置。",
    example: `runtime:\n  max-steps: ${DEFAULT_CONFIG.runtime.maxSteps}\n  turn-timeout-ms: ${DEFAULT_CONFIG.runtime.turnTimeoutMs}`,
  },
  {
    path: "runtime.provider",
    title: "Chat 模型提供商",
    purpose: "仅覆盖 `roll chat` 使用的模型提供商，便于让 Ask 与 Chat 使用不同服务。",
    defaultBehavior: "不配置时使用 `llm.default-provider`。",
    example: "runtime:\n  provider: openai",
  },
  {
    path: "runtime.model",
    title: "Chat 模型",
    purpose: "仅覆盖 `roll chat` 的主模型；子 Agent 的 sampling 也复用该模型。",
    defaultBehavior: "不配置时使用 `llm.default-model`。",
    example: "runtime:\n  model: gpt-5.5",
  },
  {
    path: "runtime.max-steps",
    title: "单轮最大步骤数",
    purpose: "限制 `roll chat` 单轮中模型继续推理和调用工具的最大步骤数。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.maxSteps}\`；达到上限后本轮停止继续调用工具。`,
    example: `runtime:\n  max-steps: ${DEFAULT_CONFIG.runtime.maxSteps}`,
  },
  {
    path: "runtime.turn-timeout-ms",
    title: "单轮超时时间",
    purpose: "限制 `roll chat` 一整轮从开始到结束可占用的总时间，单位毫秒。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.turnTimeoutMs}\`，即 5 分钟。`,
    example: `runtime:\n  turn-timeout-ms: ${DEFAULT_CONFIG.runtime.turnTimeoutMs}`,
  },
  {
    path: "runtime.threads-dir",
    title: "会话存储目录",
    purpose: "保存 `roll chat` 会话元数据和消息记录，供会话恢复与列表命令读取。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.threadsDir}\`；加载时会展开 \`~/\`。`,
    example: `runtime:\n  threads-dir: ${DEFAULT_CONFIG.runtime.threadsDir}`,
  },
  {
    path: "scheduler",
    title: "定时任务",
    purpose:
      "控制 `roll schedule` 定时任务的存储目录、数量上限与并发运行数。任务本身与运行结果在 `roll ui` 左侧「定时任务管理」面板查看和管理。",
    defaultBehavior: "所有子项都有默认值；只有需要覆盖默认行为时才写入配置。",
    example: `scheduler:\n  max-concurrent-runs: ${DEFAULT_CONFIG.scheduler.maxConcurrentRuns}`,
  },
  {
    path: "scheduler.data-dir",
    title: "定时任务数据目录",
    purpose: "保存定时任务账本 `schedules.db`、daemon 日志与 daemon 记录。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.scheduler.dataDir}\`；加载时会展开 \`~/\`。`,
    example: `scheduler:\n  data-dir: ${DEFAULT_CONFIG.scheduler.dataDir}`,
  },
  {
    path: "scheduler.max-schedules",
    title: "定时任务数量上限",
    purpose: "限制 `roll schedule add` 可登记的任务总数，防止无人清理的任务无限累积。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.scheduler.maxSchedules}\`；达到上限后新增会被拒绝。`,
    example: `scheduler:\n  max-schedules: ${DEFAULT_CONFIG.scheduler.maxSchedules}`,
  },
  {
    path: "scheduler.max-concurrent-runs",
    title: "定时任务并发数",
    purpose: "限制 `roll schedule daemon` 同时运行的 exec 子进程数量。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.scheduler.maxConcurrentRuns}\`；超出的到期任务排队等待。`,
    example: `scheduler:\n  max-concurrent-runs: ${DEFAULT_CONFIG.scheduler.maxConcurrentRuns}`,
  },
  {
    path: "scheduler.env",
    title: "定时任务运行环境变量",
    purpose: `为定时任务的运行环境补充环境变量（代理、额外 PATH 等）。调度服务由 launchd / 计划任务启动，不会加载交互终端的环境变量；roll 已自动把自身 node 所在目录加进 PATH，其余缺失变量在这里声明。值支持 \`\${ENV_VAR}\` 占位符（含 secrets.env 回退）。`,
    defaultBehavior: "默认为空；声明的变量在每次任务运行前合入进程环境，同名覆盖。",
    example: "scheduler:\n  env:\n    HTTP_PROXY: http://127.0.0.1:7890",
  },
  {
    path: "scheduler.env.<var-name>",
    title: "定时任务环境变量条目",
    purpose: "单个注入到定时任务运行环境的变量，键为变量名、值为变量值。",
    defaultBehavior: "默认没有条目；声明后在每次任务运行前合入进程环境，同名覆盖。",
    example: "scheduler:\n  env:\n    HTTP_PROXY: http://127.0.0.1:7890",
  },
  {
    path: "runtime.context-window",
    title: "上下文窗口",
    purpose: "手动声明当前 Chat 模型的上下文 token 容量，用于计算自动压缩触发点。",
    defaultBehavior: "不配置时按模型名查询内置容量表；无法识别时不按占用比例触发压缩。",
    example: "runtime:\n  context-window: 200000",
  },
  {
    path: "runtime.thinking-level",
    title: "推理强度",
    purpose: "控制 Chat 与 MCP sampling 的推理强度；可选 `off`、`low`、`medium`、`high`。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.thinkingLevel}\`；具体预算由 provider 适配层映射。`,
    example: `runtime:\n  thinking-level: ${DEFAULT_CONFIG.runtime.thinkingLevel}`,
  },

  // Agent bootstrap
  {
    path: "runtime.agent-bootstrap",
    title: "Agent 目录加载",
    purpose: "控制 `roll chat` 创建会话时发现、连接并读取已注册 Agent 工具目录的总预算。",
    defaultBehavior: "默认允许 Agent 并行加载；单个 Agent 失败时继续保留其他成功 Agent 的目录。",
    example: `runtime:\n  agent-bootstrap:\n    timeout-ms: ${DEFAULT_CONFIG.runtime.agentBootstrap.timeoutMs}`,
  },
  {
    path: "runtime.agent-bootstrap.timeout-ms",
    title: "Agent 目录加载超时",
    purpose: "限制一次 Chat 会话加载全部已注册 Agent 工具目录的总等待时间，单位毫秒。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.agentBootstrap.timeoutMs}\`；超时后停止领取未开始的加载任务，取消正在进行的连接任务，清理资源并保留已完成的部分目录。`,
    example: `runtime:\n  agent-bootstrap:\n    timeout-ms: ${DEFAULT_CONFIG.runtime.agentBootstrap.timeoutMs}`,
  },

  // Tool approval
  {
    path: "runtime.approval",
    title: "工具审批",
    purpose: "控制 Chat 调用工具时的默认授权方式，并允许按工具精确覆盖。",
    defaultBehavior:
      "默认采用 `" + DEFAULT_CONFIG.runtime.approval.default + "`，优先保护有副作用的操作。",
    example: `runtime:\n  approval:\n    default: ${DEFAULT_CONFIG.runtime.approval.default}\n    overrides: {}`,
  },
  {
    path: "runtime.approval.default",
    title: "工具默认审批策略",
    purpose:
      "决定 `roll chat` 未被单独覆盖的工具如何审批：`guarded` 按风险判断，`auto` 放行非破坏性操作，`deny` 拒绝。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.approval.default}\`。此配置不影响 \`roll ask\`。`,
    example: `runtime:\n  approval:\n    default: ${DEFAULT_CONFIG.runtime.approval.default}`,
  },
  {
    path: "runtime.approval.overrides",
    title: "单个工具审批规则",
    purpose: "按完整 `agentName.toolName` 为特定工具设置例外规则。",
    defaultBehavior: "默认为空；未命中的工具回退到 `runtime.approval.default`。",
    example:
      "runtime:\n  approval:\n    overrides:\n      browser-use-agent.zhipin_send_prepared_reply: confirm\n      browser-use-agent.browser_status: auto",
  },
  {
    path: "runtime.approval.overrides.<tool>",
    title: "单个工具审批策略",
    purpose: "为一个完整 `agentName.toolName` 选择 `auto`、`confirm` 或 `deny`。",
    defaultBehavior: "不配置该工具时回退到 `runtime.approval.default`。",
    example: "runtime:\n  approval:\n    overrides:\n      browser-use-agent.browser_status: auto",
  },

  // Context compaction
  {
    path: "runtime.compaction",
    title: "上下文压缩",
    purpose: "在长对话接近模型上下文容量时，控制何时压缩以及保留多少近期内容。",
    defaultBehavior: "默认开启摘要压缩，并保留近期轮次与 token 预算。",
    example: `runtime:\n  compaction:\n    enabled: true\n    strategy: ${DEFAULT_CONFIG.runtime.compaction.strategy}`,
  },
  {
    path: "runtime.compaction.enabled",
    title: "自动压缩上下文",
    purpose: "允许 Chat 在上下文接近容量或收到上下文超限错误时压缩早期消息。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.compaction.enabled)}\`。`,
    example: `runtime:\n  compaction:\n    enabled: ${String(DEFAULT_CONFIG.runtime.compaction.enabled)}`,
  },
  {
    path: "runtime.compaction.strategy",
    title: "上下文压缩策略",
    purpose: "选择 `summarize` 生成交接摘要，或用 `truncate` 直接移除较早消息。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.compaction.strategy}\`；结构化输出无效或过长时退回 \`truncate\`，Provider、网络或超时错误则保留原上下文。`,
    example: `runtime:\n  compaction:\n    strategy: ${DEFAULT_CONFIG.runtime.compaction.strategy}`,
  },
  {
    path: "runtime.compaction.timeout-ms",
    title: "压缩模型超时",
    purpose: "限制结构化 Checkpoint 模型请求的总等待时间，不包含本地证据整理和持久化。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.compaction.timeoutMs)}\` 毫秒；超时保持原上下文，不自动截断。`,
    example: `runtime:\n  compaction:\n    timeout-ms: ${String(DEFAULT_CONFIG.runtime.compaction.timeoutMs)}`,
  },
  {
    path: "runtime.compaction.thinking-level",
    title: "压缩推理强度",
    purpose:
      "覆盖结构化 Checkpoint 生成的推理强度；使用 AI SDK 的统一 reasoning 语义映射到当前 Provider。",
    defaultBehavior:
      "默认不单独设置并继承 `runtime.thinking-level`；Qwen 结构化输出仍会强制关闭 thinking，不支持关闭推理的模型会在调用前报错。",
    example: "runtime:\n  compaction:\n    thinking-level: high",
  },
  {
    path: "runtime.compaction.max-output-tokens",
    title: "压缩输出 Token 上限",
    purpose: "限制结构化 Checkpoint 请求的 AI SDK 输出 token 预算。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.compaction.maxOutputTokens)}\`；Provider 的 reasoning token 也可能占用该预算。`,
    example: `runtime:\n  compaction:\n    max-output-tokens: ${String(DEFAULT_CONFIG.runtime.compaction.maxOutputTokens)}`,
  },
  {
    path: "runtime.compaction.threshold",
    title: "自动压缩触发比例",
    purpose: "当最近一次输入 token 占上下文窗口的比例达到此值时，在下一轮前压缩。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.compaction.threshold}\`。`,
    example: `runtime:\n  compaction:\n    threshold: ${DEFAULT_CONFIG.runtime.compaction.threshold}`,
  },
  {
    path: "runtime.compaction.keep-recent-turns",
    title: "保留最近对话轮数",
    purpose: "压缩时至少保留最近的用户对话轮，避免当前任务细节过早进入摘要。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.compaction.keepRecentTurns}\` 轮。`,
    example: `runtime:\n  compaction:\n    keep-recent-turns: ${DEFAULT_CONFIG.runtime.compaction.keepRecentTurns}`,
  },
  {
    path: "runtime.compaction.keep-recent-tokens",
    title: "保留最近 Token 预算",
    purpose: "压缩时用于保留近期完整对话的近似 token 预算，并与保留轮数共同取更保守边界。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.compaction.keepRecentTokens}\`。`,
    example: `runtime:\n  compaction:\n    keep-recent-tokens: ${DEFAULT_CONFIG.runtime.compaction.keepRecentTokens}`,
  },

  // Shell
  {
    path: "runtime.shell",
    title: "Shell 工具",
    purpose: "控制 Chat 是否可执行本地命令，以及一次性命令和后台会话的安全限制。",
    defaultBehavior: "默认关闭；开启后仍受工具审批策略、超时和输出上限约束。",
    example: "runtime:\n  shell:\n    enabled: true",
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.enabled",
    title: "Chat 内建 shell 工具",
    purpose:
      "在 `roll chat` 中注册命令工具：macOS/Linux 使用 `roll__bash`，Windows 使用 `roll__powershell`。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.shell.enabled)}\`（关闭）；Windows 还需要 PowerShell 7+。`,
    example: "runtime:\n  shell:\n    enabled: true",
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.auto-approve-safe",
    title: "只读命令免确认",
    purpose: "让 POSIX shell 中已识别的安全只读命令免确认；危险或无法识别的命令仍需审批。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.shell.autoApproveSafe)}\`；Windows PowerShell 命令目前仍按未知操作处理。`,
    example: "runtime:\n  shell:\n    enabled: true\n    auto-approve-safe: false",
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.default-timeout-ms",
    title: "Shell 默认超时时间",
    purpose: "为未显式传入超时的一次性 shell 命令设置执行上限，单位毫秒。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.shell.defaultTimeoutMs}\`；还会受最大超时和单轮超时限制。`,
    example: `runtime:\n  shell:\n    default-timeout-ms: ${DEFAULT_CONFIG.runtime.shell.defaultTimeoutMs}`,
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.max-timeout-ms",
    title: "Shell 最大超时时间",
    purpose: "限制模型为一次性 shell 命令请求的最长执行时间，单位毫秒。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.shell.maxTimeoutMs}\`；实际时限仍不会超过单轮超时。`,
    example: `runtime:\n  shell:\n    max-timeout-ms: ${DEFAULT_CONFIG.runtime.shell.maxTimeoutMs}`,
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.max-capture-bytes",
    title: "Shell 输出捕获上限",
    purpose: "限制 shell 标准输出与错误输出的内存捕获量，并限制后台会话输出缓冲区。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.shell.maxCaptureBytes}\` 字节。`,
    example: `runtime:\n  shell:\n    max-capture-bytes: ${DEFAULT_CONFIG.runtime.shell.maxCaptureBytes}`,
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.max-model-output-chars",
    title: "Shell 模型输出上限",
    purpose: "限制一次性 shell 工具返回给模型的 stdout 与 stderr 总字符数。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.shell.maxModelOutputChars}\` 个字符；超出部分会截断并标记。`,
    example: `runtime:\n  shell:\n    max-model-output-chars: ${DEFAULT_CONFIG.runtime.shell.maxModelOutputChars}`,
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.session",
    title: "后台命令会话",
    purpose: "让长命令跨 Chat 轮次继续运行，并通过轮询读取增量输出和退出状态。",
    defaultBehavior: "默认关闭；必须同时开启 Shell 工具，且会话随当前 Chat 进程退出。",
    example: "runtime:\n  shell:\n    enabled: true\n    session:\n      enabled: true",
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.session.enabled",
    title: "Chat 会话式长命令执行",
    purpose:
      "在 macOS/Linux 与 Windows PowerShell 7+ 中注册 `roll__exec_command`、`roll__exec_poll`、`roll__exec_list`，让长命令在后台跨轮运行。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.runtime.shell.session.enabled)}\`（关闭）；仅长驻 Chat 模式可用且需开启 \`runtime.shell.enabled\`，\`--server\` 还需显式放行 \`roll.exec_command\`。`,
    example:
      "runtime:\n  shell:\n    enabled: true\n    session:\n      enabled: true\n  approval:\n    overrides:\n      roll.exec_command: auto",
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.session.max-sessions",
    title: "后台命令会话上限",
    purpose: "限制同一 `roll chat` 进程中可保留的运行中或待领取结果的后台命令会话数。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.shell.session.maxSessions}\` 个会话。`,
    example: `runtime:\n  shell:\n    session:\n      max-sessions: ${DEFAULT_CONFIG.runtime.shell.session.maxSessions}`,
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.session.default-yield-ms",
    title: "后台命令默认等待时间",
    purpose: "设置 `exec_command` 首次返回前以及后续轮询通常等待的时间，单位毫秒。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.shell.session.defaultYieldMs}\`；调用方仍可在工具参数中覆盖。`,
    example: `runtime:\n  shell:\n    session:\n      default-yield-ms: ${DEFAULT_CONFIG.runtime.shell.session.defaultYieldMs}`,
    setupCommand: "roll config setup shell",
  },
  {
    path: "runtime.shell.session.max-output-tokens",
    title: "后台命令单次输出上限",
    purpose: "限制 `exec_command` / `exec_poll` 每次返回给模型的新输出量，以近似 token 数计。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.runtime.shell.session.maxOutputTokens}\`；运行中的会话不会因输出截断而停止。`,
    example: `runtime:\n  shell:\n    session:\n      max-output-tokens: ${DEFAULT_CONFIG.runtime.shell.session.maxOutputTokens}`,
    setupCommand: "roll config setup shell",
  },

  // Skills
  {
    path: "skills",
    title: "Skills 发现",
    purpose: "补充 `roll chat` 自动发现范围之外的 Skill 目录。",
    defaultBehavior: "标准项目级、用户级和已注册 Agent Skills 始终自动发现。",
    example: "skills:\n  dirs: []",
  },
  {
    path: "skills.dirs",
    title: "Chat 额外 skill 目录",
    purpose:
      "`roll chat` 会自动发现项目级、用户级和已注册 Agent 的 Skill。这里只填写标准范围之外的额外目录，例如团队共享目录；目录可以直接包含 `SKILL.md`，也可以包含多个 Skill 子目录。",
    defaultBehavior:
      "默认为空；`<项目>/.agents/skills`、`~/.agents/skills`，以及通过 `npx skills add` 安装到标准位置的 Skill 都会自动发现，无需重复填写。",
    example: "skills:\n  dirs:\n    - ./openclaw-roll-core-skill-template",
  },
  {
    path: "skills.dirs.<item>",
    title: "额外 Skill 目录路径",
    purpose: "添加一个额外搜索目录；它可以直接含 `SKILL.md`，也可以包含多个 skill 子目录。",
    defaultBehavior: "默认没有额外目录；项目级、用户级和已注册 Agent 的 skills 仍会自动发现。",
    example: "skills:\n  dirs:\n    - ./skills/team-shared",
  },

  // Agents
  {
    path: "agents",
    title: "Agent 管理",
    purpose: "设置 Roll 的 Agent 数据目录，并为子 Agent 声明额外环境变量。",
    defaultBehavior: "使用默认数据目录；未写入的环境变量继续从 Roll 进程环境继承。",
    example: `agents:\n  data-dir: ${DEFAULT_CONFIG.agents.dataDir}`,
  },
  {
    path: "agents.data-dir",
    title: "Agent 数据目录",
    purpose: "保存已注册 Agent、PID、日志和 runtime sidecar 等 Roll 管理数据。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.agents.dataDir}\`；加载时会展开 \`~/\`。`,
    example: `agents:\n  data-dir: ${DEFAULT_CONFIG.agents.dataDir}`,
  },
  {
    path: "agents.env",
    title: "其他 Agent 环境变量",
    purpose: "为未在独立 Agent 页面中展示的 Agent 或自定义变量提供通用键值配置入口。",
    defaultBehavior: "默认没有额外注入；已声明的注册 Agent 优先在各自页面配置。",
    example: "agents:\n  env:\n    custom-agent:\n      FEATURE_FLAG: enabled",
    setupCommand: "roll config setup agent <agent-name>",
  },
  {
    path: "agents.env.<agent-name>",
    title: "Agent 环境变量组",
    purpose: "按 Agent 名称组织需要注入子进程的环境变量。",
    defaultBehavior: "默认没有额外注入；子进程仍继承当前 Roll 进程环境。",
    example:
      "agents:\n  env:\n    browser-use-agent:\n      REPLY_AUTHORITY_URL: https://example.com",
    setupCommand: "roll config setup agent <agent-name>",
  },
  {
    path: "agents.env.<agent-name>.<variable>",
    title: "Agent 环境变量",
    purpose: "为一个 Agent 注入单个字符串环境变量；同名值会覆盖父进程继承值。",
    defaultBehavior: "不配置时沿用 Roll 进程中的同名环境变量；core-managed Agent 需重启后生效。",
    example:
      "agents:\n  env:\n    browser-use-agent:\n      REPLY_AUTHORITY_URL: https://example.com",
    setupCommand: "roll config setup agent <agent-name>",
  },

  // Installation
  {
    path: "install",
    title: "安装与更新",
    purpose: "控制 Agent 安装和 Roll 更新时使用的 npm 软件源、重试、缓存与超时。",
    defaultBehavior: "默认使用 npm 自身的软件源，并采用 Roll 的安全网络默认值。",
    example: `install:\n  fetch-retries: ${DEFAULT_CONFIG.install.fetchRetries}\n  prefer-offline: false`,
    setupCommand: "roll config setup install",
  },
  {
    path: "install.registry",
    title: "npm Registry 地址",
    purpose: "指定 `roll agent install` 与 `roll update` 查询和安装 npm 包时使用的软件源。",
    defaultBehavior: "不配置时使用 npm 自身默认源；Roll 不做隐式镜像 fallback。",
    example: "install:\n  registry: https://registry.npmmirror.com",
    setupCommand: "roll config setup install",
  },
  {
    path: "install.fetch-retries",
    title: "安装下载重试次数",
    purpose: "设置 npm `--fetch-retries`，同时作为 Roll 安装网络操作的整体重试次数。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.install.fetchRetries}\` 次。`,
    example: `install:\n  fetch-retries: ${DEFAULT_CONFIG.install.fetchRetries}`,
    setupCommand: "roll config setup install",
  },
  {
    path: "install.prefer-offline",
    title: "优先使用本地缓存",
    purpose: "决定 npm 安装时是否附加 `--prefer-offline`，优先复用本地缓存元数据。",
    defaultBehavior: `默认值为 \`${String(DEFAULT_CONFIG.install.preferOffline)}\`，优先获取新鲜元数据。`,
    example: `install:\n  prefer-offline: ${String(DEFAULT_CONFIG.install.preferOffline)}`,
    setupCommand: "roll config setup install",
  },
  {
    path: "install.network-timeout-ms",
    title: "安装网络超时时间",
    purpose: "限制单次 npm install 命令的等待时间，单位毫秒。",
    defaultBehavior: `默认值为 \`${DEFAULT_CONFIG.install.networkTimeoutMs}\`，即 120 秒。`,
    example: `install:\n  network-timeout-ms: ${DEFAULT_CONFIG.install.networkTimeoutMs}`,
    setupCommand: "roll config setup install",
  },

  // Browser instances
  {
    path: "browser",
    title: "浏览器实例",
    purpose: "管理 browser-use-agent 可以连接或启动的浏览器实例及默认选择。",
    defaultBehavior: "未声明实例时继续使用 legacy 单实例环境变量配置。",
    example: "browser:\n  instances: {}",
  },
  {
    path: "browser.default-instance",
    title: "默认浏览器实例",
    purpose: "指定工具未传 `browserInstance` 时优先选择的已声明实例。",
    defaultBehavior: "不配置且只有一个实例时自动选择；有多个实例时必须由调用方指定。",
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
  {
    path: "browser.instances.<instance>",
    title: "单个浏览器实例",
    purpose: "用一个稳定名称描述浏览器连接方式、Profile、窗口和业务归属。",
    defaultBehavior: "默认使用本地托管 Chrome；仍必须为每个实例设置独占 Profile 目录和 CDP 端口。",
    example:
      "browser:\n  instances:\n    boss-a:\n      mode: managed-cdp\n      cdp-port: 9222\n      user-data-dir: ~/.roll-agent/browser/boss-a",
  },
  {
    path: "browser.instances.<instance>.platform",
    title: "业务平台",
    purpose: "标记该浏览器实例属于 BOSS 直聘（`zhipin`）还是鱼泡（`yupao`），用于平台匹配校验。",
    defaultBehavior: "不配置时实例不限定业务平台，平台专用工具不会做实例平台冲突校验。",
    example: "browser:\n  instances:\n    boss-a:\n      platform: zhipin",
  },
  {
    path: "browser.instances.<instance>.mode",
    title: "浏览器连接模式",
    purpose: "选择本地托管浏览器、远程 CDP，或连接用户已启动浏览器会话。",
    defaultBehavior: "默认值为 `managed-cdp`。",
    example: "browser:\n  instances:\n    boss-a:\n      mode: managed-cdp",
  },
  {
    path: "browser.instances.<instance>.headless",
    title: "无头运行",
    purpose: "控制 `managed-cdp` 启动的浏览器是否隐藏窗口；其他连接模式不使用此项。",
    defaultBehavior: "不配置时继承 browser-use-agent 全局设置，默认显示浏览器窗口。",
    example: "browser:\n  instances:\n    boss-a:\n      headless: false",
  },
  {
    path: "browser.instances.<instance>.cdp-url",
    title: "CDP 连接地址",
    purpose: "提供 `remote-cdp` 或 `existing-session` 模式要连接的 HTTP(S) / WebSocket CDP 地址。",
    defaultBehavior: "这两种模式下无默认值且必须填写；`managed-cdp` 使用 host 与 port 生成地址。",
    example:
      "browser:\n  instances:\n    chrome-open:\n      mode: existing-session\n      cdp-url: http://127.0.0.1:9222",
  },
  {
    path: "browser.instances.<instance>.cdp-host",
    title: "本地 CDP 主机",
    purpose: "指定 `managed-cdp` 启动后用于健康检查和连接的 CDP 主机地址。",
    defaultBehavior: "默认值为 `127.0.0.1`；远程与已有会话模式不使用此项。",
    example: "browser:\n  instances:\n    boss-a:\n      cdp-host: 127.0.0.1",
  },
  {
    path: "browser.instances.<instance>.cdp-port",
    title: "本地 CDP 端口",
    purpose: "指定 `managed-cdp` 浏览器的远程调试端口；每个实例必须使用不同端口。",
    defaultBehavior: "`managed-cdp` 实例无默认值且必须填写；其他模式不使用此项。",
    example: "browser:\n  instances:\n    boss-a:\n      cdp-port: 9222",
  },
  {
    path: "browser.instances.<instance>.channel",
    title: "浏览器类型",
    purpose: "选择 `managed-cdp` 启动系统 Chrome、Playwright Chromium 或 Microsoft Edge。",
    defaultBehavior: "默认值为 `chrome`；配置 `executable-path` 后此项会被忽略。",
    example: "browser:\n  instances:\n    boss-a:\n      channel: chrome",
  },
  {
    path: "browser.instances.<instance>.executable-path",
    title: "浏览器程序路径",
    purpose: "为 `managed-cdp` 指定浏览器可执行文件，适合非标准安装位置或定制版本。",
    defaultBehavior: "不配置时按 `channel` 查找系统浏览器；配置后优先使用此路径。",
    example:
      "browser:\n  instances:\n    boss-a:\n      executable-path: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  {
    path: "browser.instances.<instance>.user-data-dir",
    title: "浏览器 Profile 目录",
    purpose:
      "为实例声明独占的 Profile 目录；`managed-cdp` 在此保存登录态，状态检查也会检查其可写性。",
    defaultBehavior: "无默认值；每个已声明实例都必须填写。",
    example:
      "browser:\n  instances:\n    boss-a:\n      user-data-dir: ~/.roll-agent/browser/boss-a",
  },
  {
    path: "browser.instances.<instance>.sessions-dir",
    title: "浏览器会话目录",
    purpose: "保存 Roll 的页面会话快照，与浏览器自身的 Profile 数据分开存放。",
    defaultBehavior: "不配置时使用 `~/.roll-agent/browser/sessions/<instance-id>`。",
    example:
      "browser:\n  instances:\n    boss-a:\n      sessions-dir: ~/.roll-agent/browser/sessions/boss-a",
  },
  {
    path: "browser.instances.<instance>.args",
    title: "浏览器启动参数列表",
    purpose: "仅为本地托管浏览器追加确有必要的命令行开关。",
    defaultBehavior: "默认使用 browser-use-agent 内置启动参数，不追加自定义值。",
    example: "browser:\n  instances:\n    boss-a:\n      args:\n        - --lang=zh-CN",
  },
  {
    path: "browser.instances.<instance>.args.<item>",
    title: "浏览器启动参数",
    purpose: "向 `managed-cdp` 浏览器追加一个命令行参数；仅添加确实需要的开关。",
    defaultBehavior: "默认不追加自定义参数；远程与已有会话模式不使用此项。",
    example: "browser:\n  instances:\n    boss-a:\n      args:\n        - --lang=zh-CN",
  },
  {
    path: "browser.instances.<instance>.profile-name",
    title: "浏览器 Profile 名称",
    purpose: "设置托管 Chrome 窗口显示的 Profile 名称，帮助区分多个业务账号。",
    defaultBehavior: "不配置时使用浏览器实例 ID。",
    example: "browser:\n  instances:\n    boss-a:\n      profile-name: BOSS 主账号",
  },
  {
    path: "browser.instances.<instance>.profile-color",
    title: "浏览器 Profile 颜色",
    purpose: "用六位十六进制颜色标记托管 Chrome Profile，帮助肉眼区分多个窗口。",
    defaultBehavior: "不配置时按实例顺序自动分配不同颜色。",
    example: 'browser:\n  instances:\n    boss-a:\n      profile-color: "#2563EB"',
  },
  {
    path: "browser.instances.<instance>.window-bounds",
    title: "窗口位置与大小",
    purpose: "可选地固定托管浏览器窗口的屏幕位置和尺寸。",
    defaultBehavior: "整组留空时，多实例可视模式会自动排布窗口。",
    example:
      "browser:\n  instances:\n    boss-a:\n      window-bounds:\n        x: 0\n        y: 0\n        width: 960\n        height: 900",
  },
  {
    path: "browser.instances.<instance>.window-bounds.x",
    title: "窗口横向位置",
    purpose: "设置托管浏览器窗口左上角距主屏左侧的像素数。",
    defaultBehavior: "整个 `window-bounds` 未设置时，多实例可视模式会自动排布；否则交由系统决定。",
    example: "browser:\n  instances:\n    boss-a:\n      window-bounds:\n        x: 0",
  },
  {
    path: "browser.instances.<instance>.window-bounds.y",
    title: "窗口纵向位置",
    purpose: "设置托管浏览器窗口左上角距主屏顶部的像素数。",
    defaultBehavior: "整个 `window-bounds` 未设置时，多实例可视模式会自动排布；否则交由系统决定。",
    example: "browser:\n  instances:\n    boss-a:\n      window-bounds:\n        y: 0",
  },
  {
    path: "browser.instances.<instance>.window-bounds.width",
    title: "窗口宽度",
    purpose: "设置托管浏览器窗口宽度，单位像素，必须大于 0。",
    defaultBehavior: "整个 `window-bounds` 未设置时，多实例可视模式会自动排布；否则交由系统决定。",
    example: "browser:\n  instances:\n    boss-a:\n      window-bounds:\n        width: 960",
  },
  {
    path: "browser.instances.<instance>.window-bounds.height",
    title: "窗口高度",
    purpose: "设置托管浏览器窗口高度，单位像素，必须大于 0。",
    defaultBehavior: "整个 `window-bounds` 未设置时，多实例可视模式会自动排布；否则交由系统决定。",
    example: "browser:\n  instances:\n    boss-a:\n      window-bounds:\n        height: 900",
  },
  {
    path: "browser.instances.<instance>.tracking-agent-id",
    title: "招聘事件 Agent ID",
    purpose: "为该浏览器实例上报的招聘事件指定归因 Agent ID。",
    defaultBehavior:
      "不配置时回退到 `RECRUITMENT_EVENTS_DEFAULT_AGENT_ID`；两者都没有时状态标记为未配置。",
    example: "browser:\n  instances:\n    boss-a:\n      tracking-agent-id: zhipin-boss-a",
  },
] as const satisfies readonly ConfigGuidanceEntry[];

export function listConfigGuidanceEntries(): readonly ConfigGuidanceEntry[] {
  return CONFIG_GUIDANCE_ENTRIES;
}

export function findConfigGuidance(path: string): ConfigGuidanceEntry | undefined {
  const normalizedPath = normalizeUserPath(path.split("."));
  return CONFIG_GUIDANCE_ENTRIES.find((entry) => matchesGuidancePath(entry.path, normalizedPath));
}

function matchesGuidancePath(pattern: string, normalizedPath: readonly string[]): boolean {
  const patternParts = normalizeUserPath(pattern.split("."));
  if (patternParts.length !== normalizedPath.length) {
    return false;
  }

  return patternParts.every(
    (part, index) => part.startsWith("<") || part === normalizedPath[index],
  );
}

export function flattenAgentEnvDeclarations(
  declarations: AgentSkillEnvDeclarations | undefined,
): ReadonlyArray<AgentEnvDeclaration & { readonly required: boolean }> {
  return [
    ...(declarations?.required ?? []).map((item) => ({ ...item, required: true })),
    ...(declarations?.optional ?? []).map((item) => ({ ...item, required: false })),
  ];
}

export function isSecretEnvDeclaration(declaration: AgentEnvDeclaration): boolean {
  return declaration.secret ?? true;
}
