# @roll-agent/runtime

## 0.2.0

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

## 0.1.0

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
