# @roll-agent/core

## 0.26.0

### Minor Changes

- [#192](https://github.com/steveoon/roll-agent/pull/192) [`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd) Thanks [@steveoon](https://github.com/steveoon)! - Show concise model-generated explanations in Shell approval prompts and expose them to Runtime
  Protocol GUI clients through the backward-compatible approval preview.

  Keep conservative Shell confirmation behavior while hiding misleading destructive labels for
  commands that were not actually classified as dangerous.

### Patch Changes

- Updated dependencies [[`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd)]:
  - @roll-agent/runtime@0.13.0

## 0.25.0

### Minor Changes

- [#191](https://github.com/steveoon/roll-agent/pull/191) [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494) Thanks [@steveoon](https://github.com/steveoon)! - Add Runtime Protocol 1.1 bidirectional approval requests, expose them through the
  `roll runtime serve --stdio` CLI, and provide typed Node handlers, connection-scoped
  correlation, AbortSignal cancellation, authoritative terminal approval events,
  Companion candidate brokering, observer/transport fail-closed boundaries, and a compatible
  Protocol 1.0 fallback.

### Patch Changes

- Updated dependencies [[`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494), [`86f6777`](https://github.com/steveoon/roll-agent/commit/86f677784542e5c9eb803ce8dbbe5017eda18a37)]:
  - @roll-agent/runtime@0.12.0

## 0.24.0

### Minor Changes

- [#182](https://github.com/steveoon/roll-agent/pull/182) [`705bde7`](https://github.com/steveoon/roll-agent/commit/705bde7f9d35450eff777073f6026907084864cf) Thanks [@steveoon](https://github.com/steveoon)! - 新增版本化 Roll Runtime Protocol v1、正式的 `roll runtime serve --stdio` 入口与
  `RuntimeService` 安全 UI 投影，同时保留旧 `roll chat --server` / `session.*` RPC。

  发布 Node 客户端与本地 Companion/Relay 基础包，支持显式工作区、流式事件、审批与取消、
  有界进程内幂等、Snapshot 恢复、事件 ACK/gap 缓冲、工作区生命周期 lease、出站 Relay 重连
  以及可插拔的敏感工作区端到端加密。cipher-bound Workspace 会拒绝明文请求并只发送加密
  response/event；算法、密钥管理、生产 Cloud Relay 与本机确认 UI 仍由宿主实现。

  Node 客户端会协商并暴露初始化结果，提供请求超时与 Runtime 退出订阅，并在畸形帧、非法
  事件或响应 DTO 不匹配时关闭连接、拒绝挂起请求；同时提供可等待、幂等的分阶段
  `shutdown()`；显式关闭或协议失败都会等待真实进程退出，并依次关闭 stdin、发送 SIGTERM、
  必要时 SIGKILL，避免 GUI 宿主退出后遗留 Runtime 或 Agent 子进程。连接结果不明确时会把
  活动 Turn 标记为 `outcome unknown`，交由 UI 通过 Snapshot 收敛且不自动重放副作用。

  Companion 与 Runtime 在各自公布的有界窗口内缓存并校验 mutation `requestId`，活动项不会
  被容量淘汰，大型读取响应不会进入缓存；Companion 还会限制 ACK 不能越过当前连接已发送的
  事件，并隔离每次重连的发送队列。Browser/Shell lease 由宿主手动接线，Turn/Approval lease
  自动维护；缓存、ACK、sequence 与 lease 均为进程内状态。重复投递不会重复执行副作用，
  同时保留稳定的 Runtime `rollCode` 与 Relay `code` / `retryable`。

- [#182](https://github.com/steveoon/roll-agent/pull/182) [`aebf351`](https://github.com/steveoon/roll-agent/commit/aebf3518bc8b0d5dde25bfcb5061cd59906d16af) Thanks [@steveoon](https://github.com/steveoon)! - 为 core-managed HTTP Agent 增加中断租约释放的产品级恢复：`roll agent health` 与
  `roll doctor` 会识别并报告可恢复状态，`roll agent stop <name>` 在交互确认后完成恢复，
  非交互环境可显式使用 `--recover`。

  恢复流程会重新获取 lifecycle lock，并再次验证租约 owner、Runtime 进程身份、其他活动
  租约及文件身份；任何状态无法证明安全时继续拒绝停止和清理。

### Patch Changes

- Updated dependencies [[`705bde7`](https://github.com/steveoon/roll-agent/commit/705bde7f9d35450eff777073f6026907084864cf)]:
  - @roll-agent/runtime@0.11.0

## 0.23.0

### Minor Changes

- [#172](https://github.com/steveoon/roll-agent/pull/172) [`9743f0b`](https://github.com/steveoon/roll-agent/commit/9743f0bdce77cff3fe10b79278d66193c86cefae) Thanks [@steveoon](https://github.com/steveoon)! - 为 `roll chat` Agent bootstrap 增加可配置的全局超时和端到端取消，确保超时或 Engine
  关闭时停止排队任务、取消在飞连接，并在返回部分 catalog 前释放新建连接与使用租约。

### Patch Changes

- Updated dependencies [[`9743f0b`](https://github.com/steveoon/roll-agent/commit/9743f0bdce77cff3fe10b79278d66193c86cefae), [`78150ab`](https://github.com/steveoon/roll-agent/commit/78150aba296181536017a14a9b172a2484202f2c)]:
  - @roll-agent/runtime@0.10.0

## 0.22.0

### Minor Changes

- [#168](https://github.com/steveoon/roll-agent/pull/168) [`7dc5e1a`](https://github.com/steveoon/roll-agent/commit/7dc5e1afb2e0b939866d4bc0f1dbda87bf45ac71) Thanks [@steveoon](https://github.com/steveoon)! - Add cross-process usage leases for core-managed HTTP Agents so `roll chat`, `roll run`, and
  `roll ask` can share one runtime without one client shutting it down underneath another. Explicit
  `roll agent start` creates persistent runtimes, while lease-started runtimes stop after the final
  holder exits; `agent stop`, install, remove, and update now respect active usage and lifecycle locks.

  Persist stable process identity and runtime retention in sidecar schema v3 while continuing to read
  legacy v2 sidecars. Invalid Roll configuration no longer falls back to and mutates the default Agent
  registry during update. Agent updates reject in-place name changes and can recreate a missing npm
  install directory without losing rollback semantics.

  Expose the optional `ConversationEngineOptions.acquireAgentUsage` integration hook so runtime hosts
  can provide their own usage-lease acquisition policy.

### Patch Changes

- [#168](https://github.com/steveoon/roll-agent/pull/168) [`9aee8b2`](https://github.com/steveoon/roll-agent/commit/9aee8b2872fd9dbaaa74262a8bb20e470835e337) Thanks [@steveoon](https://github.com/steveoon)! - Make the `roll chat` confirmation panel shrink to its content while preserving the terminal row
  budget, returning unused space to the conversation transcript.

  Render assistant Markdown through the same preview component during streaming and after completion,
  while preserving the dimmed presentation of thinking segments.

- Updated dependencies [[`7dc5e1a`](https://github.com/steveoon/roll-agent/commit/7dc5e1afb2e0b939866d4bc0f1dbda87bf45ac71)]:
  - @roll-agent/runtime@0.9.0

## 0.21.0

### Minor Changes

- [#166](https://github.com/steveoon/roll-agent/pull/166) [`d31f24a`](https://github.com/steveoon/roll-agent/commit/d31f24aea007487c57bbb20374f62ac68290fff3) Thanks [@steveoon](https://github.com/steveoon)! - Systematically stabilize `roll chat` during terminal resizing with a bounded fullscreen viewport,
  coalesced full-frame resize rendering, scrollable windowed history, responsive input and popup
  layout, terminal-safe fallback modes, IME-aware real cursor placement, and main-screen restoration on
  exit. Add
  `chat.screen-mode` and `--screen-mode` with `auto`, `fullscreen`, and `inline` options.

### Patch Changes

- Updated dependencies []:
  - @roll-agent/runtime@0.8.0

## 0.20.0

### Minor Changes

- [#163](https://github.com/steveoon/roll-agent/pull/163) [`7a14d26`](https://github.com/steveoon/roll-agent/commit/7a14d2667e2bc92297279ea64d415f61e8c68236) Thanks [@steveoon](https://github.com/steveoon)! - Add native xAI Grok model support, including configuration setup, the `grok-4.5` 500k context window, reasoning effort, and visible reasoning summaries in `roll chat`.

  Keep nested `roll` commands on the same CLI instance that launched Chat, so development sessions no longer cross over to an older globally installed release. Preserve completed steps and redacted tool progress when a turn is interrupted, and replace technical cancellation notices with user-facing status copy.

- [#163](https://github.com/steveoon/roll-agent/pull/163) [`70f941d`](https://github.com/steveoon/roll-agent/commit/70f941d7bdee83635ac4d9d5f2947ec748331ad4) Thanks [@steveoon](https://github.com/steveoon)! - Improve `roll chat` prompt editing: use the full row before wrapping mixed-width drafts, keep the caret layout stable, navigate soft-wrapped rows with up/down, and recall up to 50 recent inputs from an empty prompt.

- [#163](https://github.com/steveoon/roll-agent/pull/163) [`692b351`](https://github.com/steveoon/roll-agent/commit/692b351d91dad93909971cff8c1bcf641db562a5) Thanks [@steveoon](https://github.com/steveoon)! - Strengthen `roll chat` with resource-aware batch tool scheduling, typed three-layer tool results, bounded context-overflow replay, and direct explicit Skill preloading scoped to the active Turn with reference-only persistence. Durable Tool evidence now uses bounded write-time-redacted projections, automatic per-thread retention, and explicit Raw RPC authorization. Add atomic V2 compaction checkpoints with V1 compatibility, transcript recovery, provider-portable schema-constrained semantic drafts, user-only destructive transitions, structured constraint revocation, exact model-facing evidence excerpts, bounded evidence batches and watermarks, and deterministic hard-bounded checkpoint reminders. Semantic state is the validated V2 recovery fact source; compatibility goal/constraint projections must match it, and the state is injected once per Turn instead of duplicating derived summaries in active history. Legacy V1 active snapshots migrate only as low-confidence uncertainties, are atomically archived as redacted paginated transcript evidence, and remain untouched when the first V2 reminder cannot expose every migrated fragment. Also add a fail-closed capability manifest, safe debug snapshots, and a real Ink PTY performance harness with optional fail-closed baseline comparison.

  Without a durable transcript store, legacy V1 checkpoints now remain active instead of being upgraded into V2 state whose source evidence could not be recovered.

  Keep explicit Skill bodies scoped to the active turn, and persist only lightweight Skill references. Bound and redact durable Tool evidence, prune it by age and per-thread quota, and require explicit host authorization before JSON-RPC clients can request the retained raw/input projection.

  Stream provider reasoning into a separate, non-persisted Ink thinking block and show responsive per-phase turn status above the prompt without conflating model wait, reasoning, reply, or tool activity.

  Make schema-constrained compaction configurable through `runtime.compaction.timeout-ms`, `runtime.compaction.max-output-tokens`, and an optional `runtime.compaction.thinking-level` override. Compaction now defaults to a 120-second provider budget and 8192 output tokens, inherits the runtime thinking level through AI SDK's unified reasoning semantics where supported, keeps Qwen's required structured-output thinking override, reports phase timings in verbose mode, and recognizes xAI's non-streaming output-limit response without weakening fail-closed history and checkpoint semantics.

### Patch Changes

- [#163](https://github.com/steveoon/roll-agent/pull/163) [`b89325c`](https://github.com/steveoon/roll-agent/commit/b89325c373f1b62b21b089e0a358d244acd33730) Thanks [@steveoon](https://github.com/steveoon)! - Serialize concurrent `roll agent install` calls with an owned sibling lock while keeping npm's final prefix stable, and clean up only directories owned by a failed invocation.

- Updated dependencies [[`7a14d26`](https://github.com/steveoon/roll-agent/commit/7a14d2667e2bc92297279ea64d415f61e8c68236), [`692b351`](https://github.com/steveoon/roll-agent/commit/692b351d91dad93909971cff8c1bcf641db562a5), [`ade7265`](https://github.com/steveoon/roll-agent/commit/ade7265993a3755795e7c46f86119818aa5c9874)]:
  - @roll-agent/runtime@0.8.0

## 0.19.0

### Minor Changes

- [#146](https://github.com/steveoon/roll-agent/pull/146) [`d5cfdd0`](https://github.com/steveoon/roll-agent/commit/d5cfdd051110b58d4ab46ea0656ceb6316f9b3bf) Thanks [@steveoon](https://github.com/steveoon)! - Add the on-demand `roll ui` local configuration console with schema-derived forms, safe YAML editing, secret redaction, revision checks, and runtime activation planning.

  Expose typed Agent environment metadata so both the CLI and configuration UI can reuse the same declarations.

  Agent env declarations now fail closed: omitting `secret` is equivalent to `secret: true`, so authors must mark non-sensitive fields explicitly with `secret: false`.

  Harden managed Agent activation with OS process-start identities so stale or legacy PID metadata fails closed instead of signaling a reused PID.

### Patch Changes

- [#145](https://github.com/steveoon/roll-agent/pull/145) [`66dec47`](https://github.com/steveoon/roll-agent/commit/66dec47b70c6576877352bc6b498851863913e04) Thanks [@steveoon](https://github.com/steveoon)! - `roll chat` Ink 欢迎 banner 增加一次性 logo 入场揭示动画（缓动 + 光刃前沿），播完定格进 Static，不影响长会话流式输出重绘。

- [#146](https://github.com/steveoon/roll-agent/pull/146) [`a8f68d2`](https://github.com/steveoon/roll-agent/commit/a8f68d2f9ca2d51a9aa417752982d0e2d9621fc3) Thanks [@steveoon](https://github.com/steveoon)! - Fix multi-turn `roll chat` failures against OpenAI-compatible Responses endpoints by replaying
  conversation history instead of relying on server-stored response item IDs.
- Updated dependencies [[`d5cfdd0`](https://github.com/steveoon/roll-agent/commit/d5cfdd051110b58d4ab46ea0656ceb6316f9b3bf)]:
  - @roll-agent/runtime@0.7.1

## 0.18.0

### Minor Changes

- [#142](https://github.com/steveoon/roll-agent/pull/142) [`99bab1b`](https://github.com/steveoon/roll-agent/commit/99bab1b2f4ec3f1ade87a3024abd3197d7a4d05a) Thanks [@steveoon](https://github.com/steveoon)! - 在 Windows PowerShell 7+ 上启用 `roll chat` 会话式长命令执行，新增有界的 `exec_list`
  恢复入口，并补全跨轮轮询、本轮 Esc 中断、轮超时保活与可等待的关闭清理语义。
  无法确认进程树已清理的会话会显式返回 `cleanup-failed`，并在读取该终态前继续占用会话名额。

### Patch Changes

- Updated dependencies [[`99bab1b`](https://github.com/steveoon/roll-agent/commit/99bab1b2f4ec3f1ade87a3024abd3197d7a4d05a)]:
  - @roll-agent/runtime@0.7.0

## 0.17.0

### Minor Changes

- [#140](https://github.com/steveoon/roll-agent/pull/140) [`103ab9d`](https://github.com/steveoon/roll-agent/commit/103ab9d8aa76954fc23727fb8fea67dd013b5970) Thanks [@steveoon](https://github.com/steveoon)! - `roll chat` 新增可恢复上下文的 Esc 中断协议，并让已安装 skill 的脚本路径与进程退出状态可判定。
  - Ink 执行态支持 legacy VT 与 kitty keyboard 编码的 Esc 中断；工具确认框中的 Esc 仍只拒绝当前工具。
  - 取消事件区分 user / timeout / runtime，保留已经完成的 AI SDK steps 与取消标记，避免 UI 历史存在但下一轮模型上下文丢失。
  - 用户取消会在模型两次后台任务轮询之间 interrupt 当前会话的 exec 进程；若进程在 grace window 内未退出，会升级为 terminate，避免管理器清空后遗留失联进程；服务端另提供 `session.close` 做完整资源释放。
  - turn timeout 使用 Roll 自有 abort reason，provider 网络超时仍按真实错误上报，不再被误判成整轮 300000ms 超时。
  - `roll__skill` 返回 canonical `SKILL_ROOT`，相对脚本与 reference 统一从该目录解析，不再猜测 `.roll`、`.claude` 或其它安装位置。
  - reference 加载不再为取得根路径重复读取 `SKILL.md`，并区分“skill 不存在”和“reference 不存在”。
  - `roll__skill` 列出的 references 相对路径在 Windows 上也统一为正斜杠 canonical 形式，模型回传两种分隔符均可解析。
  - shell 结果显式标记 abort / timeout；后台 exec 仅在用户主动取消时中断当前会话，运行时总超时不会误杀已后台化任务。

- [#140](https://github.com/steveoon/roll-agent/pull/140) [`103ab9d`](https://github.com/steveoon/roll-agent/commit/103ab9d8aa76954fc23727fb8fea67dd013b5970) Thanks [@steveoon](https://github.com/steveoon)! - `roll chat` Ink 输入框支持完整光标编辑（readline-lite），Windows 与 macOS 键位同时生效。
  - 新增 grapheme-aware 纯函数编辑模型 `line-buffer`（基于 `Intl.Segmenter`），所有插入与删除在文本拼接后重新归一光标边界，汉字、emoji ZWJ 序列、组合字符不会被劈半；显式多行草稿支持行间 ↑/↓ 移动并按终端显示宽度列记忆 goal column。
  - 新增数据驱动键位绑定表 `editor-keymap`：←/→ 移动、Home/End 与 Ctrl+A/E 行首行尾、Ctrl+←→（Windows 习惯）与 Option+←→（macOS 双编码 ESC b/f 与 CSI 1;3）词跳转、Ctrl+W/Option+Backspace 删词、Ctrl+U/K 删到行首/行尾。平台差异是同一语义命令的多条绑定数据，无平台探测分支。
  - 光标以反色渲染于所在字符，替换原行尾装饰性假光标；普通输入、IME 多字符与粘贴均插入在光标处。
  - 行为变化：Delete 键（`ESC[3~`）从等价退格改为正向删除（光标在末尾时为 no-op）；启用 bracketed paste（Ink `usePaste`）后粘贴含换行的文本会整段插入光标处，不再触发提交。不支持 bracketed paste 的终端维持原行为。
  - slash 弹窗激活时 ↑/↓/Tab 仍优先服务候选选择；Shift+Tab、Alt+./,、Ctrl+J 换行与 kitty 协议残留过滤等既有行为不变。
  - `displayWidth` 从 `markdown.ts` 抽至独立 `display-width.ts`，统一使用与 Ink 相同的 grapheme-aware terminal width 语义，修正 emoji modifier、ZWJ、旗帜与 emoji presentation 的列宽；Markdown 表格、状态栏、命令列表截断和纵向光标共享同一算法。
  - CI `windows-shell-smoke` 新增 display-width / line-buffer / editor-keymap / text-prompt 四个测试文件，宽度与键位测试（legacy VT 与 kitty 双编码）在 windows-latest 真实运行。
  - ↑/↓ 以草稿中的显式换行为行边界；终端自动软折行不参与光标行模型。

- [#140](https://github.com/steveoon/roll-agent/pull/140) [`62ff3f9`](https://github.com/steveoon/roll-agent/commit/62ff3f9e00115f93bb0a2becf0f214636932decb) Thanks [@steveoon](https://github.com/steveoon)! - MCP Sampling 复用 `runtime.thinking-level` 全局配置：子 Agent 借用指挥官 LLM 推理时（`roll ask` / `roll run` / `roll chat`），reasoning/thinking effort 使用同一档位映射。
  - `resolveLLMCall` 对 `sampling` purpose 注入与 `chat` 相同的 `thinkingProviderOptions`；`ask` / `run` 构造 sampling model 改走统一解析入口。
  - `ConversationEngine` 把初始档位传给子 Agent Sampling；Ink TUI 的 `/think`、`/effort` 与快捷键切档后，主会话和已缓存 MCP 连接的后续 Sampling 请求同步更新，新接入 Agent 也使用最新档位。
  - Sampling 严格保留子 Agent 请求的 MCP `maxTokens` 上限，不会为了 provider thinking budget 静默扩大答案长度。
  - 行为变化：Sampling 此前不带 thinking 配置（走 provider 默认），现在默认跟随配置档位（默认 `medium`；Qwen 为 `enableThinking + 8192 thinkingBudget`）。如需关闭，设 `runtime.thinking-level: off` 或在交互会话中执行 `/think off`。

### Patch Changes

- Updated dependencies [[`103ab9d`](https://github.com/steveoon/roll-agent/commit/103ab9d8aa76954fc23727fb8fea67dd013b5970), [`62ff3f9`](https://github.com/steveoon/roll-agent/commit/62ff3f9e00115f93bb0a2becf0f214636932decb)]:
  - @roll-agent/runtime@0.6.0

## 0.16.0

### Minor Changes

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`ea76679`](https://github.com/steveoon/roll-agent/commit/ea76679d8c390570b7baffef507579bda2058eb5) Thanks [@steveoon](https://github.com/steveoon)! - `roll agent install` 同名冲突改为显式授权替换，防止静默覆盖本地/Git 来源的 Agent 注册。
  - 同名 Agent 已通过 `local-path` / `git` 等非 npm 来源注册时，安装默认失败并给出两条出路：`roll agent remove <name>` 或新增的 `--force` 标志（确认风险后替换为 npm 安装）
  - catalog 短名安装在 npm download 前预检冲突，零副作用提前失败；非 catalog 包在 discover 后拦截，并清理本次新建的安装目录，不留孤儿目录（既有目录如 npm 升级场景不受影响）
  - `roll setup` 向导对「已通过其他来源注册」的官方 Agent 维持替换语义（选项文案已明示），自动授权替换；chat 会话内 `roll__agent_install` 不授权替换，冲突时如实返回失败原因与终端处理指引
  - 替换在线 core-managed 旧 Agent 且新版本未随即启动（缺必填 env 或 `--no-start`）时，优雅停止旧进程并将注册状态归位 idle，不再遗留运行旧代码的孤儿进程；setup 阶段失败同样停止旧进程
  - 修正 `roll agent install --start` 帮助文案与默认语义相反的问题（默认自动启动，`--no-start` 跳过）

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`cf271e4`](https://github.com/steveoon/roll-agent/commit/cf271e45b7cb6a57c2ee66e97f73600440835491) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 支持新设备 onboarding：启动引导 + 会话内安装官方 Agent。

  **启动引导（core）**：TTY 下 `roll chat` 检测到 LLM 未配置完成（provider 缺失、apiKey 为空或仍是未解析的 `${ENV_VAR}` 占位符）时，询问是否进入初始化向导（配置 LLM + 可选多选安装官方 Agent），完成后重新加载配置直接进入对话；拒绝、非 TTY、`--json`、`--server` 不进向导，直接报错并区分「provider 未配置」「apiKey 未配置」「apiKey 占位符未解析」三类原因（`--server` 与交互模式共用同一就绪判定）。

  **会话内安装（runtime + core）**：
  - 新增内建 `roll__agent_install` 工具，输入 schema 从官方 catalog 短名派生（`z.enum`，不接受任意 npm 包名）；catalog 为空时不注册
  - **强制确认门**：policy `deny` 可拒绝，但任何放行配置（含 `auto`）都仍需用户界面确认——安装会执行 npm install，policy 只能收紧不能绕过；确认 UI 复用现有 confirmation-required 事件链，`--json` 模式自动拒绝
  - chat 内安装固定 `skipBrowserSetup`（规避 turn 超时），结果附终端补装命令与缺失 env 清单；启动走与 CLI 安装同一状态机（`installAgent` autoStart：starting → online/error + 失败清理），不经引擎隐式保活路径
  - **会话内热刷新**（仅限新安装的 Agent）：安装成功后引擎连接新 Agent（`prepareAgentRefresh`）、会话合并新工具集 + 重建 skill library + 更新 system prompt（`applyAgentRefresh`），新工具从下一轮对话可用，无需重启会话
  - system prompt 新增条件段：无已注册 Agent 时向模型注入官方可装清单与"须经用户同意才安装"的纪律；有 Agent 后该段自动消失
  - 已知限制：会话内重装**已接入**的同名 Agent 时不热替换旧连接（MCP client 按名缓存），注册层仍幂等（store replace），工具结果如实提示"更新需重启 roll chat 生效"；Ink banner 的 agent 计数与 slash 补全列表为会话挂载时快照，重开会话后一致

  引擎测试封闭性不变：`explicitSources` / `explicitAgents` 路径不启用安装工具，现有测试行为零变化。

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`cf271e4`](https://github.com/steveoon/roll-agent/commit/cf271e45b7cb6a57c2ee66e97f73600440835491) Thanks [@steveoon](https://github.com/steveoon)! - 配置发现与写入逻辑统一到 `~/roll.config.yaml` 全局兜底，修复"配置目录级 vs 数据全局级"的旅程错位。
  - **发现链**：cwd 向上查找不变（项目级配置仍优先），新增最终兜底 `~/roll.config.yaml`——在 home 之外的目录也能找到全局配置
  - **写入**：`roll config init` / `roll config setup` / `roll setup` / chat 启动向导在未发现任何已有配置时，统一写入 `~/roll.config.yaml`（原为写入当前目录，导致换目录后"配置丢失"、agent 全局注册但 env 随目录失效）；已发现配置时仍写回原位置
  - 测试基建：config 相关测试全部隔离 `$HOME`，避免读写开发机真实全局配置

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`cf271e4`](https://github.com/steveoon/roll-agent/commit/cf271e45b7cb6a57c2ee66e97f73600440835491) Thanks [@steveoon](https://github.com/steveoon)! - 新增官方 Agent Catalog 声明层，解决新设备"不知道有什么可装"的发现断裂。
  - `registry/catalog.ts`：内置官方 agent 清单（browser-use、smart-reply、reply-policy-tuner、octopus），单一数据源供 CLI 短名安装 / `roll setup` / chat onboarding 后续消费；`getAgentCatalog(config?)` 预留企业私有 catalog 合并点（本期不实现 schema）
  - `registry/catalog-discovery.ts`：**动态 catalog 发现**——`npm search` 扫描 `@roll-agent` scope，按 `package.json#rollAgent` manifest 判定"可安装 agent"（sdk/core 等非 agent 包自动排除），`npm view` 补齐描述；短名从包名派生（去 scope 与 `-agent` 后缀，冲突回退完整名）；结果缓存 `~/.roll-agent/catalog-cache.json`（TTL 24h，按 `install.registry` 隔离——registry 变更后缓存视为 miss，私有 registry 发现的条目不会泄漏到其他 registry 环境），与内置清单合并（内置元数据优先），离线/失败降级缓存→内置。CLI 命令（`agent install`/`list --available`/`setup`）走缓存优先并可联网刷新；chat 引擎只读缓存，启动不被网络阻塞
  - `roll agent install <短名>`：支持 `browser-use` / `browser-use@0.21.1` 等短名与短名带版本解析为完整 npm spec，命中时 stderr 明示解析结果；非 catalog 输入行为不变
  - `roll agent list --available`：列出 catalog 中可安装 agent 及安装状态（未装 / 已装版本 / 其他来源已装）、npm latest 版本（复用 update-check 24h 缓存，离线降级 unknown）与必需环境变量摘要；`--json` 输出结构化数组

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`3044cab`](https://github.com/steveoon/roll-agent/commit/3044cabc6d35729d06ef434724a34121fc139d01) Thanks [@steveoon](https://github.com/steveoon)! - 新增内建 shell 工具，让 roll chat 能在本机执行 shell 命令，解锁"脚本编排型 skill"（如 roll-zhipin-unread-reply）在会话中的执行。macOS/Linux 注册 `roll__bash`，Windows 原生在检测到 PowerShell 7+ 时注册 `roll__powershell`。

  设计借鉴 codex 的 shell 工具：单字符串 `command` + `workdir`（禁 cd）+ `timeout_ms` 参数；两阶段输出截断（捕获期硬字节帽 + 排干防死锁，模型侧保头尾中间截断）；超时/中止杀整个进程组并归一 exit 124；`tool-output-delta` 流式事件（限流）在 Ink TUI 与基础 REPL 实时渲染输出尾行。

  **安全姿态（默认关闭，`runtime.shell.enabled`）**：
  - shell 命令一律标记 `destructiveHint`，因此无论 `runtime.approval.default` 是 `guarded` 还是 `auto` 都需人工确认；只有显式配置 `runtime.approval.overrides: { "roll.bash": "auto" }` 或 `{ "roll.powershell": "auto" }` 才允许无确认执行。无策略时 fail-closed 强制确认。
  - 审批 UI（Ink + 基础 REPL）完整展示 `command`（不截断）/ `workdir`（解析为绝对路径）/ `timeout_ms`，用户能看清将要执行的完整命令再决定。
  - 命令继承 roll 进程的全部环境变量（含 API key），等同于用户本人开 shell；风险由审批门控制，工具描述已注明。
  - 单条命令有效超时取 `min(timeout_ms, maxTimeoutMs, turnTimeoutMs)`，保证不会因超过整轮预算被 turn abort 突兀杀掉。

  Windows session exec 暂不支持；审批记忆、沙箱、跨会话持久化审批规则留作后续版本。

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`3044cab`](https://github.com/steveoon/roll-agent/commit/3044cabc6d35729d06ef434724a34121fc139d01) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 的内建 POSIX shell 能力新增两项（在 T0 `roll__bash` 基础上）：

  **T1a — 命令分类器（`runtime.shell.auto-approve-safe`，默认开启）**

  纯 JS 规则分类器把 POSIX 命令分为 known-safe / dangerous / unknown。known-safe 只读命令（`ls`/`cat README.md`/`git status`/`grep -r TODO src` 等）自动免确认执行，dangerous（`rm -rf`、`sudo`）与 unknown 仍需人工确认。设计借鉴 codex 的白名单 + 逐命令 flag 审计（`find` 拒 `-exec`/`-delete`、`git` 只放行只读子命令并拦全局 `-c`/`--git-dir`、`sed` 仅 `-n Np`、`base64` 拒写文件等），复合命令用保守词法方案（含 `$`/反引号/重定向/子 shell 等危险元字符即降级为 unknown）替代 tree-sitter，误判方向永远偏向"更保守 → 走确认"。Windows PowerShell 本批不启用安全白名单，命令全部按 unknown 走确认门。

  免确认有**工作区边界**：吃路径的命令出现绝对路径、`~` 或 `..` 参数（如 `cat ~/.ssh/id_rsa`、`find / -name x`、`rg secret /Users/x`）即降级 unknown 走确认，`grep`/`rg` 的 pattern 参数与 `echo` 等非文件命令豁免以避免误报；`workdir` 参数逃出会话根目录同样强制确认。分类器经 config→engine→session 注入，one-shot 与 session exec 显式共用同一个 effective classifier，避免两处 toolset 的兜底差异改变审批行为；gate/policy 零改动。关掉 `auto-approve-safe` 回归 T0 的默认逐条确认，显式 approval override 仍优先。

  **T2 — 会话式执行（`runtime.shell.session`，默认关闭）**

  新增两个 POSIX 内建工具 `roll__exec_command` + `roll__exec_poll`，解决长脚本（如 zhipin `reply-unread-safely.sh`，几十秒到几十分钟）被单轮 `turnTimeout` 杀掉的问题。`exec_command` 后台启动命令、等待一个 yield 窗口后返回：进程结束则给退出码，未结束则返回 `session_id`；`exec_poll` 用该 id 空轮询续查进度、读退出码，或发送 Ctrl-C 哨兵（U+0003）中断。借鉴 codex `unified_exec` 的 yield-then-return-partial 与后台隐式化，采精简版：pipe 会话（不引 node-pty native 依赖）、会话池只回收已退出槽（满则拒绝，不杀活进程）、head+tail 缓冲、机器可读干净环境（`NO_COLOR`/`TERM=dumb`/`PAGER=cat`）。

  **关键安全与生命周期**：会话进程绝不绑 turn 的 abortSignal，得以跨轮存活突破 `turnTimeout`；`exec_command` 走与 bash 同一套 gate（`--server` 下需 `runtime.approval.overrides: { "roll.exec_command": "auto" }` 显式授权），`exec_poll` 只轮询/中断不过 gate；session exec 只在交互 REPL 与 `--server` 长驻模式注册——单条消息 / `--json` 单轮的会话随进程结束，不提供该工具，避免返回一个立即失效的 running session id；`AgentSession.abort()` 与 `roll chat` 退出的 finally 都会 `terminateAll()`（SIGTERM→SIGKILL 升级）杀掉背景进程组，杜绝 detached 进程残留。Windows 原生暂不注册 session exec，避免给出当前无法可靠维护的后台 PowerShell 会话语义。

  审批记忆（本会话记住此命令）、沙箱、跨会话持久化审批规则列为后续阶段。

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`cf271e4`](https://github.com/steveoon/roll-agent/commit/cf271e45b7cb6a57c2ee66e97f73600440835491) Thanks [@steveoon](https://github.com/steveoon)! - 新增 `roll setup` 一键初始化命令，串起新设备 onboarding 全流程：LLM 配置 → 安装网络（可选）→ 官方 Agent 多选安装（来自 catalog，标注已装/可更新状态）→ 缺失环境变量引导 → `roll doctor` 检查摘要。
  - 全程 clack 交互（stderr），已有配置时询问是否重配；任一环节取消即退出，agent 安装失败不阻断后续环节
  - `installAgent()` 在启动前检查必填环境变量：core-managed Agent 缺 env 时跳过自动启动（不再硬启动失败），返回 envReport 交由调用方引导配置，setup 配置后提示 `roll agent start`；chat onboarding 对缺 env 的已装 Agent 输出配置提示，结束语引导 `roll setup` / `roll doctor` 补全检查
  - `setupLlm` / `setupInstall` / `setupAgentEnv` 成功消息明示配置写入路径（新设备通常为 `~/roll.config.yaml`）
  - 所有 setup 入口在消费交互输入前检查已知 breaking config migration，并引导先运行 `roll config migrate`；无迁移时仍允许向导修复不完整的目标配置段。`config migrate` 会先校验迁移结果，再创建 `.bak` 和写回原文件
  - 修复 clack text 输入 `required + defaultValue` 组合下默认值不可用的问题：此前直接回车报「此项不能为空」且看不到默认值；现在空输入回退 defaultValue，且默认值兜底显示为 placeholder（影响 setup 的 model、fetch-retries 等所有带默认值的必填输入）
  - 新增 `roll config setup shell` 模块：交互式配置 `runtime.shell`（chat 内建 shell 工具开关、POSIX 安全命令自动放行、session exec），并挂入 `roll setup` 编排为可选步骤；`roll config setup bash` 保留为兼容 alias，但写入新字段。所有默认值保持「关」，开启必须显式选择。同步把 `runtime.shell` 段补进 config key-codec，修复 `config set/get` 对该段 kebab-case 键名不转换的问题
  - 复用既有模块：`roll config setup` 的 llm/install/agent-env 向导函数（本次导出）、catalog 可用性检查、doctor 命令
  - 前置重构：`roll agent install` 的安装编排抽为 `registry/install.ts` 的 `installAgent()`——纯函数化（不写 exitCode、不直接打日志），进度经 reporter 事件回调（step/info/warn/success/retry），失败返回 `{ ok: false, step, message, retryCommand? }` 六阶段状态机（resolve/download/discover/setup/register/start），协作函数全部可注入测试；CLI 命令变薄壳，行为与输出保持不变
  - `roll agent add` / `roll agent install` 的安装后 env 引导抽为共享 `agent-env-guidance.ts`

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`cf271e4`](https://github.com/steveoon/roll-agent/commit/cf271e45b7cb6a57c2ee66e97f73600440835491) Thanks [@steveoon](https://github.com/steveoon)! - 新增 `roll skills install <source>`：把 skill 安装到 orchestrator（Claude Code / Codex / 通用 `.agents`）的 skills 目录，打通新设备上外部编排器获取 roll-core 等 skill 的路径（企业内部 repo 分发，不经公开 npm）。
  - source 支持本地目录（直含 SKILL.md 或多 skill 子目录集合）与 Git 仓库 URL（克隆到 `<dataDir>/skill-repos/`，重复安装自动 pull）
  - 目标解析：`--dir` 自定义目录 > `--target claude-code,codex,agents|all` > TTY 交互多选（默认勾选检测到使用痕迹的 orchestrator）> 非交互报错；`--project` 切换到项目级目录（如 `.claude/skills`）
  - 安装即托管：重复安装先删目标目录再整目录复制（覆盖前警告列出将被覆盖项），`--skill` 可只装集合中的指定项，`--json` 输出结构化安装结果
  - SKILL.md frontmatter 校验 name/description 非空，无效项跳过并告警
  - 配套重构：git clone/pull 抽为共享 `cli/utils/git-source.ts`（`roll agent add` 改用，行为不变）；`ConfigPromptAdapter` 新增 `multiselect`；`expandTilde` 从 config loader 导出

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`cd499cd`](https://github.com/steveoon/roll-agent/commit/cd499cdbf88124b6a7460ab1ff93e7805ddd6b7c) Thanks [@steveoon](https://github.com/steveoon)! - 新增 `ShellProfile` 抽象并落地 Windows 原生 PowerShell 7 one-shot 支持。
  - macOS/Linux 继续使用 POSIX profile，工具名保持 `roll__bash`，审批 key 保持 `roll.bash`，session exec 继续只在 POSIX 注册。
  - Windows 只在检测到 `pwsh` 主版本 >= 7 时注册 `roll__powershell`，审批 key 为 `roll.powershell`；探测会把 PATH 与标准 Program Files 中完整限定的候选解析并缓存为绝对 `pwsh.exe`，拒绝 cwd/相对 PATH 候选。候选按顺序惰性检查，首个通过即停止，版本探测共享 5 秒总预算。未检测到或版本过低时跳过注册并提示安装 `Microsoft.PowerShell`。
  - PowerShell 命令通过 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` 执行，`EncodedCommand` 使用 UTF-16LE base64，审批 UI、分类器和日志仍展示编码前明文命令；wrapper 显式设置 UTF-8 输出，并把 cmdlet 错误与 native `$LASTEXITCODE` 传播为真实退出码。
  - Windows one-shot 不启用 detached 进程组，超时/中止使用 `SystemRoot\\System32\\taskkill.exe /PID <pid> /T /F` 清理进程树；`taskkill` 启动失败、非预期退出或超时会触发根进程强制终止兜底（退出码 128 视为目标进程已退出的正常竞速，不触发兜底），清理仍无法确认时会返回明确错误且不无限等待。PowerShell 命令本批全部分类为 `unknown`，默认过确认门；显式 `roll.powershell` approval override 仍优先。
  - 过长的 PowerShell `EncodedCommand` 会在 spawn 前返回清晰错误，避免落到含糊的 Windows 命令行长度失败。
  - 配置 canonical 字段从 `runtime.bash` 迁移为 `runtime.shell`，迁移器支持自动改名、camelCase/kebab-case 语义等值双写删除 legacy、冲突双写阻塞，段内等值别名会在迁移时去重为单一键；`roll config setup shell` 成为新命令，`roll config setup bash` 保留兼容 alias。所有 setup 入口会在读取业务输入前提示先完成已知 breaking migration，避免输入到最后一步才被丢弃。
  - Windows 下 `roll config setup shell` 只引导 one-shot 开关，不再询问当前不会生效的安全命令自动放行和 session exec 选项。
  - CI 新增 `windows-latest` shell smoke，覆盖 profile 选择、PowerShell one-shot、配置迁移和 engine 注册。

### Patch Changes

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`078922f`](https://github.com/steveoon/roll-agent/commit/078922fabef77703378079b1abe45cf5d3436b61) Thanks [@steveoon](https://github.com/steveoon)! - Fix official `octopus-agent` handling by supporting legacy mapped `roll-env-file` declarations in `roll doctor` and resolving catalog installs by skill name such as `octopus-agent`.

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`cf271e4`](https://github.com/steveoon/roll-agent/commit/cf271e45b7cb6a57c2ee66e97f73600440835491) Thanks [@steveoon](https://github.com/steveoon)! - 统一 stdio 子 Agent 的环境变量继承口径：`buildStdioChildEnv` 现在始终继承宿主 `process.env`（config `agents.env` 同名项优先覆盖），与 core-managed spawn 行为一致。

  此前 stdio 子进程仅在 config 配置了至少一个 env 时才继承宿主环境，导致三处口径互相矛盾：env 检测（`inspectAgentEnvRequirements`）认可 shell 环境变量、`roll doctor` 运行态实测却报「运行态缺失」、且给 Agent 配置任意一个变量会隐式改变其他宿主变量的可见性（非单调）。统一后 shell 中已 export 的必填变量在运行态真实可用，doctor 对此类变量的结论从误报 fail（运行态缺失）修正为 warn（运行态漂移，提示尚未持久化到 YAML）；真实缺失仍照常报错。

- Updated dependencies [[`ea76679`](https://github.com/steveoon/roll-agent/commit/ea76679d8c390570b7baffef507579bda2058eb5), [`cf271e4`](https://github.com/steveoon/roll-agent/commit/cf271e45b7cb6a57c2ee66e97f73600440835491), [`3044cab`](https://github.com/steveoon/roll-agent/commit/3044cabc6d35729d06ef434724a34121fc139d01), [`3044cab`](https://github.com/steveoon/roll-agent/commit/3044cabc6d35729d06ef434724a34121fc139d01), [`cd499cd`](https://github.com/steveoon/roll-agent/commit/cd499cdbf88124b6a7460ab1ff93e7805ddd6b7c)]:
  - @roll-agent/runtime@0.5.0

## 0.15.0

### Minor Changes

- [#134](https://github.com/steveoon/roll-agent/pull/134) [`e50b434`](https://github.com/steveoon/roll-agent/commit/e50b434e82af9bea96018340feab1000ebb7fc69) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 接入 Agent Skills 标准生态 + 重写 system prompt 工具接地纪律（修复模型不调用工具却谎报完成）。

  **Skills 接入（对齐 `npx skills add` 标准范式）**
  - 零配置自动发现 canonical 路径：项目级 `.agents/skills/*/SKILL.md`（从 cwd 向上查找）与用户级 `~/.agents/skills/`，与 Claude Code / Codex / Cursor 等共享同一批已安装 skill；`skills.dirs` 配置可追加额外目录（支持"目录即 skill"与"skill 集合目录"两种布局）
  - 已注册 Agent 的 SKILL.md 一并纳入目录（agent > project > user > config 优先级去重），chat 模型首次能看到子 Agent 的业务流程指导
  - 渐进式披露：system prompt 只注入 name + description 目录，模型按需调用内建只读工具 `roll__skill` 加载完整 SKILL.md 正文；`reference` 参数可加载 `references/` 下的引用文件（含路径逃逸防护）
  - 手动指定：Ink TUI 的 `/` 弹窗合并展示内置命令与可加载 skill；`/skills` 列出全部 skill；`/<skill-name> [/<skill-name> ...] 用户请求` 会隐藏注入加载对应 skill 的接地指令。基础 REPL 同样支持 `/skills` 和 skill 前缀
  - 新增 `@roll-agent/core/skills/library`（`createSkillLibrary`）与 config `skills.dirs` 段（含 `roll config explain skills.dirs` 指引）

  **System prompt 重写（借鉴 Codex CLI 的 prompt 结构）**
  - 新增工具接地纪律：禁止虚构工具调用或其结果、没有成功工具结果不得声称操作完成、批量任务逐项真实执行并如实汇报成败、工具失败不得掩盖
  - 新增任务推进指导：持续推进直到完成或阻塞、默认实际执行而非只给分析
  - 保留原输出通道规则（thinking/text 分离、不复述输入）；`AgentSessionOptions` 支持 `systemPrompt` / `skillLibrary` 注入，`ConversationEngine` 自动组装

  **上下文压缩接地**
  - 压缩摘要的转写不再把工具结果渲染为 `[工具结果]` 占位符，改为携带成功/失败状态与截断摘录；摘要指令明确"只把有成功工具结果佐证的操作记为已完成"，防止编造的完成声明经压缩固化为事实

- [#134](https://github.com/steveoon/roll-agent/pull/134) [`e50b434`](https://github.com/steveoon/roll-agent/commit/e50b434e82af9bea96018340feab1000ebb7fc69) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 启动 banner（Roll Agent logo）。
  - 交互式 REPL 启动时显示 ROLL 块字符 logo（cyan→magenta 六档渐变），信息行以品红 `Roll Agent` 开头，跟随版本/模型/agent 数/skill 数与按键提示
  - 降级链：非 Unicode 终端（如 PowerShell 5.1 conhost）换 slant 斜体 ASCII 渐变版；窄于 28 列省略 logo 只保留单行信息；`--json`、单条消息与 `--server` 模式不显示
  - ink TUI 中 banner 作为首条 `<Static>` 历史项渲染一次即沉入滚动缓冲区；readline 回退模式输出到 stderr
  - 修复启动时 `^[[?0u` 字符泄漏（kitty 键盘协议查询响应在 raw mode 生效前被终端回显，且会破坏 ink 首帧渲染）：render 前预开 raw mode
  - 新增 `ConversationEngine.getContextSummary()` 公开 API，返回已连接 agent/tool/skill 计数

### Patch Changes

- Updated dependencies [[`e50b434`](https://github.com/steveoon/roll-agent/commit/e50b434e82af9bea96018340feab1000ebb7fc69), [`e50b434`](https://github.com/steveoon/roll-agent/commit/e50b434e82af9bea96018340feab1000ebb7fc69)]:
  - @roll-agent/runtime@0.4.0

## 0.14.1

### Patch Changes

- [#132](https://github.com/steveoon/roll-agent/pull/132) [`f0f1f68`](https://github.com/steveoon/roll-agent/commit/f0f1f6875a80743dac3bb8f31d1dffdfcd0d1ea8) Thanks [@steveoon](https://github.com/steveoon)! - chat TUI 渲染性能与 Windows legacy 终端体验修复（实测反馈：PowerShell 5.1 流式输出闪烁、emoji 方块）。
  - **历史区改用 ink `<Static>`**：已提交的对话历史只渲染一次并沉入滚动缓冲区，动态重绘区缩小到流式区 + 状态栏 + 输入框。修复 legacy conhost（PowerShell 5.1/cmd）上对话变长后触发 ink 整屏清除路径导致的持续闪烁；所有终端上长对话的重绘开销也大幅下降（含键击热路径的历史数组复制消除）
  - **emoji 字形降级**：`🧠`/`⏵⏵`/`🗜` 在不支持 Unicode 的终端（legacy conhost）降级为 `think`/`>>`/`*`，消除方块乱码；Windows Terminal 与 macOS 不受影响
  - **转写区内边距**：历史与流式内容统一 1 列水平缩进（工具行 3 列，流式活跃工具行对齐），输入框/确认框内边距由 1 列加宽到 2 列，hint 行随缩进对齐
  - **终端宽度为 0 的防御**：`stdout.columns` 报 0（conhost 窗口调整瞬间、部分 CI PTY）时不再逐字符竖排折行，回退 80 列
  - **流式提交零跳变**：live 区流式文本补上与历史 assistant 条目一致的上边距，提交瞬间文本不再垂直位移

- Updated dependencies []:
  - @roll-agent/runtime@0.3.0

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
