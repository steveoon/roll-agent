# @roll-agent/core

## 0.14.0

### Minor Changes

- [#130](https://github.com/steveoon/roll-agent/pull/130) [`4025eb2`](https://github.com/steveoon/roll-agent/commit/4025eb23fa98ef5b9d5d8fee031c65598c656de9) Thanks [@steveoon](https://github.com/steveoon)! - chat 模式新增 Auto Mode，并重设计工具确认框。
  - **Auto Mode**：Shift+Tab 随时开关自动批准工具调用（backtab 与 kitty 协议编码均支持）。开启后确认（Yes/No）被自动批准不再打断执行；正在等待确认时按 Shift+Tab 会立即批准当前待决项并对后续生效（对齐 Claude Code 交互）。新增 `/auto` 命令（`on` / `off` / 无参切换）兜底部分终端拦截 backtab 的场景。开启时输入框 hint 与状态栏显示黄色 `⏵⏵ auto` 徽标（状态栏窄屏不丢弃该段）；每会话默认关闭，不持久化
  - **确认框重设计**：黄色圆角边框（延续输入框形状语言，避免确认时 footer 布局塌陷）；显示工具入参（经脱敏与 80 字符截断），不再盲批；新增快捷键提示行（含 Esc 取消与 Shift+Tab 说明）；`Y`/`N` 大写输入同样生效
  - 纯 UI 层实现：runtime 的 ToolPolicy 与 approve/reject 协议不变，policy `deny` 仍然直接拒绝

### Patch Changes

- [#130](https://github.com/steveoon/roll-agent/pull/130) [`ae1f7d5`](https://github.com/steveoon/roll-agent/commit/ae1f7d5f6f44db8b02a831e77f6e3a319e8fc838) Thanks [@steveoon](https://github.com/steveoon)! - Windows 兼容性加固（基于全库静态审计，报告见 docs/windows-compatibility.md）。
  - **stdio 子进程编码**：`buildStdioChildEnv` 注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`（可被 agent env 显式覆盖），消除 Windows 上 Python 子 Agent 按 locale 编码写 stdout 导致的中文乱码；非 Node Agent 接入文档补充 UTF-8 编码要求
  - **BOM 容忍**：registry 层读取 `package.json` / sidecar / agents.json 统一经 `readJsonFile`（strip UTF-8 BOM），修复 Windows 工具写入 BOM 后 `roll agent add` 报 `Invalid package.json` 的问题
  - **托管进程 spawn**：`process-manager` 切换 cross-spawn（Windows 上可解析 `.cmd`/`.bat` 启动命令，与 MCP SDK 行为对齐）并设置 `windowsHide`；`roll agent stop` 在 Windows 提示强制终止语义
  - **home 解析统一**：config 的 `~` 展开改用 `os.homedir()`（与 ThreadStore 一致，避免 Git Bash 下 `HOME`/`USERPROFILE` 不一致导致数据目录分裂），并支持 `~\` 前缀
  - **agents.json 原子写**：临时文件 + rename，避免崩溃时半截写入被静默清空
  - **chat spinner 降级**：不支持 Unicode 的终端（legacy conhost 等）自动从 braille 降级为 ASCII 帧

- Updated dependencies []:
  - @roll-agent/runtime@0.3.0

## 0.13.0

### Minor Changes

- [#128](https://github.com/steveoon/roll-agent/pull/128) [`2089a38`](https://github.com/steveoon/roll-agent/commit/2089a3878096b366f75e25f55b4c9f342bb50ed8) Thanks [@steveoon](https://github.com/steveoon)! - 升级 AI SDK 至 v7 线，新增 claude-sonnet-5 支持。
  - **依赖升级**：`ai` ^6.0.154→^7.0.9、`@ai-sdk/provider` ^3.0.8→^4.0.1、`@ai-sdk/anthropic` ^3.0.68→^4.0.4、`@ai-sdk/openai` ^3.0.52→^4.0.4、`@ai-sdk/deepseek` ^2.0.29→^3.0.2、`@ai-sdk/alibaba` ^1.0.17→^2.0.3。zod 保持 v3 不变。
  - **claude-sonnet-5**：新版 `@ai-sdk/anthropic` 完整识别 `claude-sonnet-5` / `claude-opus-4-8` / `claude-fable-5`（128k maxOutputTokens、结构化输出、adaptive thinking）；旧版会将其降级为未知模型（4096 tokens、无结构化输出）。
  - **类型跟随**：provider 接口 `LanguageModelV3`→`LanguageModelV4`、`SharedV3ProviderOptions`→`SharedV4ProviderOptions`；`ToolCallOptions`（已移除）→`ToolExecutionOptions<unknown>`。均为类型层面机械迁移，运行时行为不变。
  - **adaptive thinking 识别修复**：`claude-sonnet-5` / `claude-fable-5` 等无 minor 版本号的 model id 此前匹配不上版本正则，误走 `thinking: enabled + budgetTokens` 导致 API 400（该系模型仅接受 adaptive）；现已兼容无 minor 及带日期后缀的 id，日期段不再被误判为 minor 版本。

### Patch Changes

- [#128](https://github.com/steveoon/roll-agent/pull/128) [`2089a38`](https://github.com/steveoon/roll-agent/commit/2089a3878096b366f75e25f55b4c9f342bb50ed8) Thanks [@steveoon](https://github.com/steveoon)! - roll chat TUI 可读性优化（表格对齐、状态栏语义、取消痕迹）。
  - **表格对齐修复**：宽度计算改用 East Asian Width 近似（CJK/全角=2，`·`「」等窄符号=1，零宽字符=0），并按渲染后的 inline 文本测宽（不再把 `` ` ``/`**` 等 markdown 语法算进宽度）；分隔线与单元格等宽。CJK 表格从此不再错位。
  - **块级间距**：markdown 块之间加 1 行垂直间距，表格/段落/列表不再挤成一团。
  - **状态栏**：上下文段改为 `ctx 187.3k/200.0k (7% left)`，并按余量升级颜色（≤25% 黄、≤10% 红）；本轮用量明确标注 `turn in … out …`，不再与 session 累计混淆。非 TTY 的 usage line 同步此格式。
  - **取消/策略拒绝痕迹**：工具被用户取消或策略拒绝时，历史中记录 dim 的 `⊘ agent.tool 已取消/策略拒绝` 行（替代红色 ✗ 失败行），«已取消执行»正文降为 dim 系统样式，不再像模型回复。
  - **工具历史行带参数**：完成的工具行在名称后 dim 显示入参（沿用 80 字符截断与脱敏）。
  - **error/notice 悬挂缩进**：`✗`/`⚠` 消息换行后与正文对齐，不再顶格回绕。

- [#128](https://github.com/steveoon/roll-agent/pull/128) [`2089a38`](https://github.com/steveoon/roll-agent/commit/2089a3878096b366f75e25f55b4c9f342bb50ed8) Thanks [@steveoon](https://github.com/steveoon)! - 用量统计精度提升与 qwen think 标签泄漏修复。
  - **context window 表**：补 `claude-sonnet-5` / `claude-opus-4-7` / `claude-opus-4-6` 条目（均 1M，依据官方模型文档）。此前 `claude-sonnet-5` 落到通用 `claude` 兜底 200k，状态栏余量低报 5 倍。
  - **SessionTokenUsage** 新增 `cacheWriteTokens`（映射 AI SDK v7 `inputTokenDetails.cacheWriteTokens`，session 累计同步）；`message-finish` 事件新增 `outputTokensPerSecond`（取自 v7 finish-step performance stats）。
  - **状态栏**：`in` 段显示 cache write（`(+800 cached, +200 cache-write)`）；新增 `· N tok/s` 输出吞吐段。
  - **状态栏响应式两档**：按终端宽度自适应——宽度足够显示完整标签（`turn in … (+cached) out …`、`session …`、`(90% left)`）；不足时切紧凑档（`↑215.2k ↓307`、`Σ374.5k`、`43t/s`、ctx 去掉百分比括号）；仍不足按 tok/s → session → turn → think 优先级丢段，model 与 ctx 永远保留，不再出现中段截断。`formatTokens` 支持 M 单位并去除尾零（`1000.0k`→`1M`、`200.0k`→`200k`）。
  - **think 标签泄漏修复**：qwen 等模型将 `<think>` 推理内联在文本流中，当 thinking 跨越工具调用时开/闭标签被分到不同历史段，导致 `</think>` 字面量泄漏、推理文本按正文亮色渲染。`parseThinking` 兜底处理无开标签的闭标签；流式状态机跨段携带 think 开闭状态（提交时补 `<think>` 前缀，live 区同步）。

- Updated dependencies [[`2089a38`](https://github.com/steveoon/roll-agent/commit/2089a3878096b366f75e25f55b4c9f342bb50ed8), [`2089a38`](https://github.com/steveoon/roll-agent/commit/2089a3878096b366f75e25f55b4c9f342bb50ed8)]:
  - @roll-agent/runtime@0.3.0

## 0.12.0

### Minor Changes

- [#126](https://github.com/steveoon/roll-agent/pull/126) [`6dca5da`](https://github.com/steveoon/roll-agent/commit/6dca5da95d6e4cba20d8eeb8665127a0be3b9afd) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 交互式 TUI 改用 Ink 重写,并升级压缩保留与 token 用量展示(借鉴 codex CLI）。
  - **Ink TUI**：交互式 `roll chat`（TTY）改用 Ink 渲染——`<Static>` 承载已提交历史（进终端原生 scrollback，可上滚/选中），底部活区含常驻状态栏（model · % left · in/out/session · cached）、输入框与方向键工具确认。Ink 独占 stdin，消除了此前 readline↔clack 抢占 stdin 的问题。非 TTY、`--json`、one-shot `roll chat "<msg>"` 与 `--server` daemon 不加载 Ink，沿用既有顺序渲染与 readline 回退。
  - **压缩保留改 token 预算制**：新增 `runtime.compaction.keepRecentTokens`（默认 32000），从最新轮向旧累计保留——这是 soft budget，`keepRecentTurns` 作为**硬下限**：预算不足时仍至少保留 keepRecentTurns 轮（其中的超大工具结果由截断兜底）。摘要 prompt 改为「交接给另一个 LLM」的 checkpoint 框架。
  - **codex 风格 token 展示**：上下文占用显示「N% left」+ baseline headroom（小窗口自适应封顶），并透出 AI SDK 的 cached / reasoning token（`SessionTokenUsage` 新增 `cachedInputTokens` / `reasoningTokens`）。token 计算/格式化抽到共享 `token-format.ts`，TUI 状态栏与既有渲染器共用。

- [#126](https://github.com/steveoon/roll-agent/pull/126) [`e133e74`](https://github.com/steveoon/roll-agent/commit/e133e742cda9f2bca525c89ccd889af105aa1a00) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 交互式 TUI 深化:resume 历史、带框输入、Shift+Enter 换行、thinking 控制、slash 自动补全。
  - **resume 显示历史**：`roll chat --last` / `--session` 现在把已存消息转换成历史渲染（user / assistant / 工具行带 ✓✗ / 压缩摘要折叠），不再空白进入会话。
  - **带框输入**：输入区改为圆角边框的多行 input，带常驻提示行（Enter 发送 · Shift+Enter/Ctrl+J 换行 · / 命令），随终端宽度自适应。
  - **换行键**：Enter 始终发送；Shift+Enter（kitty 键盘协议，支持的终端）/ Ctrl+J 换行 —— 用 Ink 原生 kitty 支持（`render` 的 `kittyKeyboard`），不支持的终端静默降级到 Ctrl+J。
  - **thinking/reasoning 控制**：`/think on|off`、`/effort low|medium|high` 与 Alt+./Alt+, 调级，状态栏常驻 `🧠 <level>`，默认 medium。按 provider 映射 `providerOptions`（anthropic thinking / openai reasoningEffort / qwen enableThinking / deepseek thinking），运行时可切换（新增 additive `AgentSession.setProviderOptions`）。新增 `runtime.thinkingLevel` 配置。
  - **slash 自动补全**：输入 `/` 弹出命令列表（`/compact`、`/think`、`/effort`、`/help`、`/exit`；↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 取消）。退出改为 `/exit`（或 Ctrl+C），裸 `exit` / `quit` 不再触发退出而是作为普通消息发送，避免误退。
  - 非 TTY / `--json` / `--server` 路径不加载 Ink，也不会启用 kitty 键盘协议；但 chat runtime 仍会按 `runtime.thinkingLevel` 注入 provider thinking/reasoning 选项。

  说明：thinking 默认开（medium）是有意的产品决策（chat 场景推理通常带来更好回复）。若使用**非推理模型**或希望省 token，设 `runtime.thinking-level: off`。effort 在 Anthropic 4.6+ 映射为 adaptive thinking + effort，旧 Claude / qwen 映射为思考预算，openai 映射为 reasoningEffort（`off` 仅对支持 `none` 的模型发送），**deepseek 仅支持开/关**，effort 级别对其等价于「开」。

- [#126](https://github.com/steveoon/roll-agent/pull/126) [`6dca5da`](https://github.com/steveoon/roll-agent/commit/6dca5da95d6e4cba20d8eeb8665127a0be3b9afd) Thanks [@steveoon](https://github.com/steveoon)! - `roll chat` 增加 token 用量可见性与上下文自动压缩。
  - 每轮对话结束后默认显示 token 用量(本轮 in/out、session 累计、context 占用 %),不再需要 `--verbose`;`--json` 输出新增 `sessionUsage` 与 `contextWindow`。
  - 上下文接近模型 context window 时自动压缩(reactive:依据上一轮 provider 实测的 input tokens 判断,无需 tokenizer):默认把最早若干轮经 LLM 摘要折叠成一条 summary 并保留最近 N 轮原文,`runtime.compaction.strategy: truncate` 可改为零成本滑动窗口截断。
  - 压缩同时对保留轮内的超大工具结果(如 `browser_snapshot` 的完整 a11y 树)做内容截断,使含巨型工具输出的会话在压缩后真正回落到窗口内,而不是仅折叠最早几轮却仍然撑满。
  - 压缩进行中显示「压缩上下文中…」spinner,完成后汇报移除/保留条数与精简的工具结果数,避免长压缩看起来像卡死。
  - 若 provider 报 context 长度错误,当前轮会回滚用户输入并立即尝试压缩已持久化历史;摘要压缩失败时自动降级为 `truncate`,避免继续用未压缩历史重试。
  - REPL 支持 `/compact` 手动压缩,工具确认恢复为方向键选择(clack);runtime server 新增 `session.compact`;`runtime.compaction.enabled: false` 可关闭自动压缩。
  - context window 经 `runtime.context-window` 显式声明,未声明时回落内置模型表;无法识别时阈值自动压缩不可用,但明确的 context 长度错误仍会触发恢复性压缩。

  已知限制:压缩是 reactive 的(超阈值后下一轮才触发),单轮超大输入瞬时撑爆 context window 仍可能先触发一次 provider 报错,再由恢复性压缩在下一轮收敛。

### Patch Changes

- 静默 `roll chat` 自动启用 `node:sqlite` 时的实验特性提示,并在 `roll update` 遇到 `@roll-agent/*` 新包 registry metadata 短暂 `E404` 时重试安装。

  SDK：`defineAgent` 的 `logLevel` 现在支持从 `ROLL_AGENT_LOG_LEVEL` 环境变量读取(显式传入 > 环境变量 > 默认 `info`),便于在不改代码的情况下静默/调高子 Agent 日志。

- Updated dependencies [[`6dca5da`](https://github.com/steveoon/roll-agent/commit/6dca5da95d6e4cba20d8eeb8665127a0be3b9afd), [`e133e74`](https://github.com/steveoon/roll-agent/commit/e133e742cda9f2bca525c89ccd889af105aa1a00), [`6dca5da`](https://github.com/steveoon/roll-agent/commit/6dca5da95d6e4cba20d8eeb8665127a0be3b9afd)]:
  - @roll-agent/runtime@0.2.0

## 0.11.0

### Minor Changes

- [#124](https://github.com/steveoon/roll-agent/pull/124) [`9ec548f`](https://github.com/steveoon/roll-agent/commit/9ec548f3c909519175efdae9e4faa117246e4cc6) Thanks [@steveoon](https://github.com/steveoon)! - `roll chat` 从骨架填充为可用的多轮会话助手,并接入新增的 `@roll-agent/runtime` 对话引擎(首次发布 `0.1.0`)。

  新增 `@roll-agent/runtime`:
  - `ConversationEngine` + `AgentSession`:基于 AI SDK v6 `streamText` 的 agentic tool-calling loop,常驻 `McpClientManager` 连接池跨会话复用,流式 `SessionEvent`(含 token usage)
  - `ThreadStore`:`node:sqlite` 会话持久化(标题、消息历史、resume、级联删除)
  - `ToolPolicy` / `DefaultToolPolicy` / `ConfigurableToolPolicy` + `ApprovalGate`:写/发送类工具的人在环确认(token 扫描判定,可经 config 覆盖)
  - `RuntimeServer`:JSON-RPC over stdio daemon,供 GUI/前端接入

  `@roll-agent/core`:
  - `roll chat` 现已可用:多轮 REPL、`--session`/`--last` 续聊、`--list` 列出会话、`--json`、`--server` daemon;新会话自动以首条消息为标题
  - `exports` 扩展引擎层子路径供 runtime 复用;config 新增 `runtime` 段(`provider`/`model`/`maxSteps`/`threadsDir`/`approval`)
  - `bin/roll.js` 在本地源码树下自动补 `--experimental-sqlite` / `--experimental-strip-types`

### Patch Changes

- Updated dependencies [[`9ec548f`](https://github.com/steveoon/roll-agent/commit/9ec548f3c909519175efdae9e4faa117246e4cc6)]:
  - @roll-agent/runtime@0.1.0

## 0.10.1

### Patch Changes

- [#120](https://github.com/steveoon/roll-agent/pull/120) [`fa22c1e`](https://github.com/steveoon/roll-agent/commit/fa22c1e49ba9bd56166c5a53e2e9945794d53b08) Thanks [@steveoon](https://github.com/steveoon)! - Fix `roll update` for installed agents registered with a bare npm package name so it resolves the latest published version instead of reusing an old saved npm dependency range.

## 0.10.0

### Minor Changes

- [#109](https://github.com/steveoon/roll-agent/pull/109) [`4a57ae8`](https://github.com/steveoon/roll-agent/commit/4a57ae83fead389bf670099f1d11bc13c35f7a8f) Thanks [@steveoon](https://github.com/steveoon)! - 新增配置体验入口：
  - `roll config setup [llm|install|agent] [agent-name]`：使用交互式问答配置 LLM、npm install/update 网络参数和 Agent 环境变量，并在写入 `roll.config.yaml` 前创建备份。
  - `roll config explain [path]`：解释常用全局配置项和 `agents.env.<agent-name>`，Agent env 说明优先来自 Agent 的 `references/env.yaml` 声明。
  - `roll agent add` / `roll agent install` 在发现必填环境变量缺失时，会提示使用 `roll config setup agent <agent-name>` 和 `roll config explain agents.env.<agent-name>`。
  - `roll config setup` 在非交互式终端下直接报错并给出 `roll config set` / 手动编辑指引，不再进入会挂起的交互流程。
  - 配置 Agent 环境变量后，按 runtime ownership 提示生效方式（core-managed 需重启、external-managed 自行重启、on-demand 下次调用自动生效）。
  - LLM / Agent 的密钥若以明文（非 `${ENV_VAR}` 引用）写入，会提示改用环境变量引用并避免提交配置文件。
  - 已持久化的密钥类 Agent env 在重新运行 `roll config setup agent <agent-name>` 时支持回车保留当前值；用户取消向导时会返回非 0 退出码。
  - 默认模型 ID 更新为 `anthropic` -> `claude-sonnet-4-6`、`openai` -> `gpt-5.5`、`qwen` -> `qwen3.6-plus`、`deepseek` -> `deepseek-v4-flash`，并让 `setup` / `explain` / `init` 的默认值从同一份 `DEFAULT_CONFIG` 派生，降低说明文案和真实默认值漂移风险。

- [#109](https://github.com/steveoon/roll-agent/pull/109) [`91346ab`](https://github.com/steveoon/roll-agent/commit/91346abc74cec65b8b89b72f9cc1d713f3c18bbd) Thanks [@steveoon](https://github.com/steveoon)! - 增强 `roll agent install` / `roll update` 的网络韧性与跨平台（win-x64 / win-arm64 / macOS / Linux）兼容性，解决无 VPN、npm 官方源不稳定环境下的更新失败问题。
  - 新增 `install` 配置段（`roll.config.yaml`）：`registry`（显式 opt-in 镜像源，默认仍走 npm 官方源，不做隐式自动 fallback）、`fetchRetries`、`preferOffline`（默认关闭，避免更新时复用过期 npm 元数据）、`networkTimeoutMs`。通过独立的韧性 partial loader 加载，即使全局配置处于待迁移状态，安装/更新链路也保持可用；若 `install` 段自身非法，则中止安装/更新，避免静默换源。
  - 修复 `roll update` 在整体配置 YAML 不可读时无法 self-update 的回归：此时使用默认 `install` 配置继续更新；若配置文件可读但 `install` 段自身非法，仍中止更新并提示具体字段。
  - `core-managed` Agent readiness 等待默认值保持不变，同时支持通过 `ROLL_AGENT_READY_STARTUP_TIMEOUT_MS` / `ROLL_AGENT_READY_PROBE_TIMEOUT_MS` / `ROLL_AGENT_READY_INTERVAL_MS` 覆盖，便于测试和故障诊断场景缩短等待。
  - npm install / view 透传 `--registry`/`--fetch-retries`/`--prefer-offline`/`--no-audit`/`--no-fund`；安装命令在网络/超时类错误上做整体重试（次数随 `fetchRetries` 增长，上限 3 次，带退避）。
  - 网络错误友好化：识别 `ETIMEDOUT`/`ECONNRESET`/`ENOTFOUND` 等错误码与超时被 kill 的进程，给出中文提示并引导配置 `install.registry` 镜像源；配置自定义 registry 时在日志高可见提示当前源。
  - 修复 `execFile` 默认 1MB `maxBuffer` 隐患：弱网下 npm/Playwright 大量日志可能超限导致“安装其实成功却被误判失败”，统一放大缓冲上限。
  - Windows 子进程封装改用 `process.env.ComSpec` 解析 shell（兼容 win-x64 / win-arm64 及定制 shell 路径），回退 `cmd.exe`。

  不触碰发布供应链防护（`pnpm-workspace.yaml` 的 `minimumReleaseAge`/`blockExoticSubdeps`、release workflow、tarball 审计），镜像源切换仅作用于终端用户安装侧且为显式 opt-in。

## 0.9.0

### Minor Changes

- [#102](https://github.com/steveoon/roll-agent/pull/102) [`ba1c045`](https://github.com/steveoon/roll-agent/commit/ba1c045008316a33e6f482efcedeaa6991fda3ea) Thanks [@steveoon](https://github.com/steveoon)! - Add per-instance browser profile colors for managed multi-browser runtimes.

- [#102](https://github.com/steveoon/roll-agent/pull/102) [`ba1c045`](https://github.com/steveoon/roll-agent/commit/ba1c045008316a33e6f482efcedeaa6991fda3ea) Thanks [@steveoon](https://github.com/steveoon)! - Add instance-level browser stop commands that close managed browser runtimes without stopping browser-use-agent.

## 0.8.0

### Minor Changes

- [#100](https://github.com/steveoon/roll-agent/pull/100) [`4ed7e58`](https://github.com/steveoon/roll-agent/commit/4ed7e584d6a0c12586cb5e0783005d9823c36a2e) Thanks [@steveoon](https://github.com/steveoon)! - Add `roll browser clear-data` to dry-run or remove configured browser profile and session data.

- [#100](https://github.com/steveoon/roll-agent/pull/100) [`fd4917d`](https://github.com/steveoon/roll-agent/commit/fd4917d6720fd76a4b8a4f1e466ca3fa6d7ecc26) Thanks [@steveoon](https://github.com/steveoon)! - Add managed multi-browser instance support with per-instance runtime config, status reporting, profile labeling, and adaptive visible window tiling for browser-use workflows.

## 0.7.1

### Patch Changes

- [#98](https://github.com/steveoon/roll-agent/pull/98) [`1431557`](https://github.com/steveoon/roll-agent/commit/14315578effb9f8f2f035b5225b9f4904ffd7fe7) Thanks [@steveoon](https://github.com/steveoon)! - Add browser foreground policy control for native CDP interactions.

  Browser security config now supports `foregroundPolicy` with a default of `when-minimized`, so native browser actions only call `Page.bringToFront` when the target Chrome window is minimized. `browser-use-agent` applies the policy across generic ref actions and Zhipin native tools, and browser diagnostics now report the effective policy.

## 0.7.0

### Minor Changes

- [#91](https://github.com/steveoon/roll-agent/pull/91) [`e84cba2`](https://github.com/steveoon/roll-agent/commit/e84cba281b5f5a999577175db296a48e843eeff9) Thanks [@steveoon](https://github.com/steveoon)! - Add browser security policy and browser-use tool confirmation policy.
  - Add env-driven browser hard boundaries for domain allowlists, action policy decisions, and output caps.
  - Add browser-use tool-level policy with one-time approval tokens for confirm-gated tools.
  - Gate `zhipin_send_prepared_reply` with non-consuming prepared reply inspection and approval retry support.
  - Add structured tool errors in the SDK and expose them through `roll run --json`.
  - Surface browser security and tool policy summaries in `browser_status` and `roll doctor`.

## 0.6.7

### Patch Changes

- [#82](https://github.com/steveoon/roll-agent/pull/82) [`bff87f0`](https://github.com/steveoon/roll-agent/commit/bff87f022ef0411f5e97397f13d59d163ea0a2fe) Thanks [@steveoon](https://github.com/steveoon)! - Add orchestrator-focused runtime improvements across Roll and browser-use.

  Core now serves registered agent skill documents through `roll skills list|get|path`, including an opt-in `roll skills get <agent> --include-references` mode that returns referenced local `references/*` documents. `roll run` also supports `--batch-json`, `--batch-file`, and `--batch-stdin` for multiple explicit tool calls in one CLI process; `--bail` stops on first failure. `roll doctor` adds `--fix-plan` and safe `--fix` handling for config migration, missing agent data directories, and orphan core-managed runtime metadata. `roll agent health` also surfaces runtime sidecar issues (version mismatch, orphan sidecar, PID mismatch) before probing the endpoint.

  The browser-use agent now emits and accepts BOSS recommend-list `candidateRef` handles so orchestrators can pass stable tool-facing references to `zhipin_say_hello` and `zhipin_open_resume` instead of relying only on raw DOM indices.

## 0.6.6

### Patch Changes

- [#80](https://github.com/steveoon/roll-agent/pull/80) [`60f9fea`](https://github.com/steveoon/roll-agent/commit/60f9feaa027950c21e8c3cc80ce41a5aaffb85d4) Thanks [@steveoon](https://github.com/steveoon)! - Clarify CLI help text for config keys, Agent registration/update commands, and multi-word options. Multi-word flags now render as kebab-case, including `--skip-browser-setup` and `--no-start`.

## 0.6.5

### Patch Changes

- [#78](https://github.com/steveoon/roll-agent/pull/78) [`bf52fc7`](https://github.com/steveoon/roll-agent/commit/bf52fc720626db9dda77087cfd608e58ef69b6ec) Thanks [@steveoon](https://github.com/steveoon)! - Improve `roll agent list` and `roll agent tools` terminal output with width-aware tables, compact locations, and readable tool schema sections.

## 0.6.4

### Patch Changes

- [#75](https://github.com/steveoon/roll-agent/pull/75) [`5ebc424`](https://github.com/steveoon/roll-agent/commit/5ebc424f330790bf34e5d84b87a017a52d5980da) Thanks [@steveoon](https://github.com/steveoon)! - Force `roll update --check` to refresh npm-installed Agent versions instead of reusing the 24h update reminder cache.

- [#75](https://github.com/steveoon/roll-agent/pull/75) [`5ebc424`](https://github.com/steveoon/roll-agent/commit/5ebc424f330790bf34e5d84b87a017a52d5980da) Thanks [@steveoon](https://github.com/steveoon)! - Improve Windows compatibility for npm and pnpm calls used by Agent install, add, update, and update checks.

## 0.6.3

### Patch Changes

- [#69](https://github.com/steveoon/roll-agent/pull/69) [`2da5f7f`](https://github.com/steveoon/roll-agent/commit/2da5f7f3a1c0bf3a473260c22297ff0e9d2acbcd) Thanks [@steveoon](https://github.com/steveoon)! - Add native CDP primitives and migrate the BOSS Zhipin main workflow to the native backend.

  `@roll-agent/browser` now exposes native CDP controller utilities for page inspection,
  DOM evaluation, mouse input, keyboard input, text insertion, and native locators without
  requiring a Playwright page attach.

  `browser-use-agent` now routes the BOSS Zhipin chat, reply sending, WeChat exchange,
  recommend-list reading, filtering, scrolling, and greet flows through the native backend.
  The remaining resume popup tools stay Playwright-backed and share their DOM contract through
  `resume-dom-contract.ts`.

  `roll ask` preflight validation now catches array `minItems` constraints before dispatching
  tool calls, so underspecified semantic requests can return `needs_input` instead of reaching
  MCP tool validation.

## 0.6.2

### Patch Changes

- [#67](https://github.com/steveoon/roll-agent/pull/67) [`4d11426`](https://github.com/steveoon/roll-agent/commit/4d11426060071f4c1dfceaa5019f4a397d332677) Thanks [@steveoon](https://github.com/steveoon)! - Fix `roll run` JSON object input handling and add browser-use diagnostics for BOSS page attach state.

  `roll run` now accepts a third positional JSON object as explicit tool input while keeping
  `--input-json` as the recommended orchestration-safe form. `browser-use-agent` also adds
  `zhipin_diagnose_browser_state` for inspecting BOSS native page selection, attach state, page
  readiness, and automation fingerprint exposure.

## 0.6.1

### Patch Changes

- [#61](https://github.com/steveoon/roll-agent/pull/61) [`3bbaa8e`](https://github.com/steveoon/roll-agent/commit/3bbaa8efd08a8971bce84e5b9bdb8c1cc711773d) Thanks [@steveoon](https://github.com/steveoon)! - feat(core/cli): add --verbose flag and improve --json output
  - `roll run` 和 `roll ask` 新增 `--verbose` / `-v` 选项，启用后将调用参数输出到 debug 日志；默认 info 级别仅显示 agent.tool 名称
  - 敏感参数（signedEnvelope、token、secret、password、cookie、authorization、api-key）在 debug 日志中自动脱敏为 `[redacted,len=N]`
  - `roll run --json` 输出优化：MCP tool 返回单条 text block 且内容为合法 JSON 时，自动解包为对象而非嵌套的 MCP result 结构

## 0.6.0

### Minor Changes

- [#54](https://github.com/steveoon/roll-agent/pull/54) [`edded04`](https://github.com/steveoon/roll-agent/commit/edded043c69b9e83af25b3f6e6dbb49c22332b08) Thanks [@steveoon](https://github.com/steveoon)! - feat: external-agent friendly discoverability, drift detection and error context

  面向 orchestrator / 外部 agent 的一轮可用性优化，覆盖最常踩的 4 个坑：
  - **Tool discoverability**
    - core 新增 `roll agent tools <agent-name>` 命令（含 `--json`），代理 MCP `tools/list`，输出每个 tool 的 name / description / inputSchema
    - `roll run` / `roll ask` 调到不存在的 tool 时，输出 Levenshtein + token overlap 融合评分的 "Did you mean: ..." 候选 + 指向 `roll agent tools` 的提示
  - **Unified preflight output**
    - core 新增 `packages/core/src/tool-runtime/preflight.ts` 模块，一次性聚合缺失字段（递归展开父对象 → 叶子字段）
    - 错误输出分 A（输入缺失）/ B（运行条件缺失）双 section，不再按 zod 首错截断
    - `roll ask` 的 `needs_input` 响应新增 `runtimeIssues` 字段
  - **Config drift detection**
    - browser-use 新增 `diagnostic_status` 诊断能力（经 `browser_status.effectiveEnvSources` 暴露），smart-reply 新增 `diagnostic_status` tool；两者返回声明过的 env key 的 `{present, fingerprint}`（SHA256 前 8 位，不泄漏 value）
    - core 的 `roll doctor` / `roll agent info` 调用诊断 tool，对比 yaml 声明与 agent 运行态指纹，展示 `✓ from yaml (stable)` / `⚠ differs from yaml (ephemeral)` / `⚠ from shell (ephemeral)` / `✗ missing` 等六态
  - **Fail-fast on preload + error context**
    - browser-use 启动期 preload Reply Authority 公钥失败时写入 `replyAuthorityKeysLoaded=false`，`browser_status` 输出该字段，`zhipin_send_reply` 在验签前就前置拒绝并返回结构化错误
    - smart-reply 的 Reply Authority 调用统一走 `ReplyAuthorityRequestError`（携带 `meta: {url, timeoutMs, requestId}` + `Error.cause` 链 + `x-request-id` 透传）

## 0.5.2

### Patch Changes

- [#50](https://github.com/steveoon/roll-agent/pull/50) [`ac7bf45`](https://github.com/steveoon/roll-agent/commit/ac7bf45386ef74768a53f611c6821a58fa5b2f2b) Thanks [@steveoon](https://github.com/steveoon)! - refactor(core): 引入统一的 config key codec 消除 kebab↔camel 反复打补丁

  **根因**：loader 过去用递归 deep-transform 把 YAML 所有键统一转 camelCase，对 `agents.env` / `llm.providers` 这类 dynamic record 的用户键（agent 名、provider 名）也做了错误改写，导致 `roll config get` 输出与 YAML 原文不一致，`helpers.ts` 需要 camelCase 兜底，`config set` 需要 SCREAMING*SNAKE_CASE 特判绕开把 `REPLY_AUTHORITY_URL` 打成 `-r-e-p-l-y*-...`。过去两次都是下游打补丁，没修到病灶。

  **改动**：
  - 新增 `config/key-codec.ts`：显式 codec tree 声明哪些节点是 schema 固定字段（kebab↔camel 转换），哪些是 dynamic record（键原样保留）。导出 `decodeFromYaml` / `encodePathToYaml` / `normalizeUserPath` 供 loader / `config set` / `config get` 使用。
  - `loader.ts` 的 `kebabToCamelDeep` 改走 `decodeFromYaml`，删除 `DYNAMIC_RECORD_PATHS` 硬编码白名单。
  - `config set` 的 `camelToKebab` 替换为 `encodePathToYaml`，删除 SCREAMING_SNAKE_CASE 特判。
  - `config get` 接入 `normalizeUserPath`，用户输 kebab 或 camel 路径均可命中 schema 字段；record 键保持原样查找。
  - `helpers.ts` 的 `getAgentEnvFromMap` 删除 camelCase 兜底，只保留 exact match。
  - `migration.ts` 新增 `legacy-agent-env-keys` 规则：存量 non-canonical agent 名（`smartReplyAgent`、`smart-Reply-agent`、`smart_reply_agent` 等）在 `loadConfig` 阶段报错并引导 `roll config migrate`；可安全 `camelToKebab` 的自动改名，mixed-case / 含非法字符 / 与 kebab 版本同存的情况视为 blocking 要求手动处理。
  - `migration.ts` 引入 `ConfigMigrationScope`（`"llm" | "ask" | "agents"`），每条规则标注 scopes；`detectKnownConfigMigrations` 支持按 scope 过滤。`loadAgentsConfig` 只跑 `scope=agents` 规则，避免 router-to-ask 误伤 `agent list` / `doctor` 等命令在仅 router 段 legacy 时的降级可用性；`loadConfig` 跑全量规则。两者共用 `parseAndCheckMigrations` helper，补上此前 `loadAgentsConfig` 绕过 migration 检测的旁路。

  所有 read / write / lookup 路径现在都经过同一个 codec 作为唯一真相源；`roll config init` / `get` / `set` / `migrate` 四个子命令语义对齐。

## 0.5.1

### Patch Changes

- [#47](https://github.com/steveoon/roll-agent/pull/47) [`289dc16`](https://github.com/steveoon/roll-agent/commit/289dc1660ec2d1c2973e024454a3192cef6f812e) Thanks [@steveoon](https://github.com/steveoon)! - feat(smart-reply): generate_reply 全切 Reply Authority Service 云端签发

  smart-reply-agent 不再本地执行回复管线，改为向 Reply Authority Service 转发请求。
  输入新增必填 target（platform/tenantId/conversationId/candidateId），
  输出新增 signedEnvelope 和 envelopeExp。
  环境变量：REPLY_AUTHORITY_URL + REPLY_AUTHORITY_BEARER_TOKEN。

  feat(browser-use): zhipin_send_reply 实现本地 Ed25519 信封验签

  输入从 message 改为 signedEnvelope，发送前执行完整验证链路：
  Ed25519 签名校验 → iss/aud/platform 校验 → exp/iat 时间戳校验 →
  jti 防重放 → conversationId/candidateId 目标绑定校验。
  zhipin_read_messages 和 zhipin_get_candidate_info 输出补充 conversationId/candidateId。

  fix(core): agent-start 未注入 agents.env 到 core-managed 进程

  roll agent start 启动 core-managed agent 时未传递 agents.env 配置的环境变量，
  改为通过 getAgentEnv() 查找并注入。

  fix(core): config set 错误转换 SCREAMING_SNAKE_CASE 键名

  camelToKebab 对全大写+下划线格式的环境变量名（如 REPLY_AUTHORITY_KEYS_URL）
  逐字符插入连字符，现跳过此类键名。

## 0.5.0

### Minor Changes

- [#41](https://github.com/steveoon/roll-agent/pull/41) [`c52f598`](https://github.com/steveoon/roll-agent/commit/c52f59849b1f26731c28ce1af261779741f3b671) Thanks [@steveoon](https://github.com/steveoon)! - feat(core): qwen provider structured output 兼容性增强
  - 新增 resolveLLMCall()，qwen + structured-output 场景自动注入 enableThinking: false
  - LLM 路由新增 text fallback，模型不遵循 json_schema 时降级为纯文本 + JSON.parse
  - 升级 AI SDK 全线依赖至最新版本

## 0.4.0

### Minor Changes

- [#39](https://github.com/steveoon/roll-agent/pull/39) [`69c0cec`](https://github.com/steveoon/roll-agent/commit/69c0cec9096cc4c5d43e2959fb6f9a6265d42d6e) Thanks [@steveoon](https://github.com/steveoon)! - feat: installed-package subagent 真实版本检测
  - `roll update --check` 对 installed-package 类型 Agent 做真实 npm 版本比较，不再固定显示 ⬆ 图标
  - 五分类版本状态：up-to-date(✅) / update-available(⬆) / pinned-behind(📌) / unsupported-spec(?) / unknown(?)
  - `InstalledAgentSource` 新增 `installedVersion` 字段，install/update 后自动记录
  - 版本查询结果按包名缓存（TTL 24h），不阻塞 CLI 命令
  - installed-package + core-managed Agent 升级顺序修正为 stop → install → restart

## 0.3.3

### Patch Changes

- [#30](https://github.com/steveoon/roll-agent/pull/30) [`d4409be`](https://github.com/steveoon/roll-agent/commit/d4409bec1ad398a28dcaac1edc481f4d89da317d) Thanks [@steveoon](https://github.com/steveoon)! - feat: auto-detect local dev agents and fallback to type-stripping

  When spawning on-demand stdio agents registered via `local-path` or `git`,
  automatically fall back from `node dist/index.js` to
  `node --experimental-strip-types src/index.ts` if the source file exists.
  This unifies the dev fallback behavior already available for `core-managed`
  agents (like browser-use) to also cover `on-demand` agents (like smart-reply).

## 0.3.2

### Patch Changes

- [#26](https://github.com/steveoon/roll-agent/pull/26) [`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c) Thanks [@steveoon](https://github.com/steveoon)! - build: add terser minification and remove source maps from published packages
  - Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
  - Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
  - Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
  - `.d.ts` files remain intact for TypeScript consumers

## 0.3.1

### Patch Changes

- [#21](https://github.com/steveoon/roll-agent/pull/21) [`6e92776`](https://github.com/steveoon/roll-agent/commit/6e9277676a9c9a654906f5d75f998de7033765ac) Thanks [@steveoon](https://github.com/steveoon)! - fix(deps): upgrade zod from ^3.25.0 to ^3.25.76

  zod@3.25.0 缺少 dist/ 目录，导致 tsc 和运行时均无法解析模块。锁定下限到 3.25.76 修复此问题。

## 0.3.0

### Minor Changes

- [#17](https://github.com/steveoon/roll-agent/pull/17) [`dd6fee8`](https://github.com/steveoon/roll-agent/commit/dd6fee846ca32421457b5c7c44b8f0370e7a52eb) Thanks [@steveoon](https://github.com/steveoon)! - Agent env declaration system, install safety, and config migration detection
  - Fix env placeholder detection: `${FOO}` values in agents.env are now
    correctly reported as "missing" instead of falsely passing checks
  - Fix tgz/tarball install: resolveInstalledPackageRoot 3-level fallback
    for non-standard package specs
  - Fix symlink safety: roll-env-file path check uses realpathSync
  - Add agent env declaration system: SKILL.md roll-env-file + env.yaml
    contract, inspectAgentEnvRequirements in doctor/add/install/info
  - agent-install rejects git URLs and local directories with guidance
  - doctor reports per-agent env status (ok/warn/fail)
  - Config migration detection in roll update and roll doctor

## 0.2.2

### Patch Changes

- [#15](https://github.com/steveoon/roll-agent/pull/15) [`04a1f9a`](https://github.com/steveoon/roll-agent/commit/04a1f9a17f18722ec958af89e0085714f10e8097) Thanks [@steveoon](https://github.com/steveoon)! - Switch the qwen provider integration to the official `@ai-sdk/alibaba` provider.
  This fixes `roll ask` / `roll run` compatibility when using DashScope Qwen models through the core LLM layer.

## 0.2.1

### Patch Changes

- [#10](https://github.com/steveoon/roll-agent/pull/10) [`0d86a7c`](https://github.com/steveoon/roll-agent/commit/0d86a7cafc515be6d240377fdf21894ea072c4f3) Thanks [@steveoon](https://github.com/steveoon)! - Improve breaking config schema handling by adding `roll config migrate`, stronger `roll update` migration reminders, `roll doctor` config compatibility reporting, and by ensuring deprecated `router` config does not block agent management commands that only need the local agent registry.

## 0.2.0

### Minor Changes

- [#5](https://github.com/steveoon/roll-agent/pull/5) [`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e) Thanks [@steveoon](https://github.com/steveoon)! - Agent runtime management v1 and browser-use tools migration

  **@roll-agent/core**
  - Three-layer agent model: source / transport / runtime ownership
  - Store schema v2 with backward-compatible migration
  - package.json#rollAgent manifest support for agent discovery
  - PID-based process management for core-managed agents
  - CLI lifecycle commands: install/start/stop/health/update/remove
  - Argument extractor and extraction schema improvements
  - LLM router tool description fix

  **@roll-agent/browser-use-agent**
  - Migrate all 11 zhipin tools from ai-sdk-computer-use
  - Add chat-navigation helper with ensureChatOpen for single-shot mode
  - Anti-detection: randomDelay, humanDelay, scroll patterns
  - Fix DOM selectors for exchange-wechat, say-hello, get-candidate-list
  - Add navigate_active_tab tool
  - Publish as @roll-agent/browser-use-agent with rollAgent manifest

  **@roll-agent/browser**
  - Add page listing, selection, and navigation APIs to context-manager

  **@roll-agent/sdk**
  - HTTP transport shutdown order fix
