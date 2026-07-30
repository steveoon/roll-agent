# @roll-agent/runtime

## 0.12.0

### Minor Changes

- [#191](https://github.com/steveoon/roll-agent/pull/191) [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494) Thanks [@steveoon](https://github.com/steveoon)! - Add Runtime Protocol 1.1 bidirectional approval requests, expose them through the
  `roll runtime serve --stdio` CLI, and provide typed Node handlers, connection-scoped
  correlation, AbortSignal cancellation, authoritative terminal approval events,
  Companion candidate brokering, observer/transport fail-closed boundaries, and a compatible
  Protocol 1.0 fallback.

### Patch Changes

- [#189](https://github.com/steveoon/roll-agent/pull/189) [`86f6777`](https://github.com/steveoon/roll-agent/commit/86f677784542e5c9eb803ce8dbbe5017eda18a37) Thanks [@steveoon](https://github.com/steveoon)! - Preserve whether an interrupted tool call never started or has an unknown outcome, and make
  cancelled-turn recovery defer to the latest user intent.
- Updated dependencies [[`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494)]:
  - @roll-agent/protocol@0.2.0

## 0.11.0

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

### Patch Changes

- Updated dependencies [[`705bde7`](https://github.com/steveoon/roll-agent/commit/705bde7f9d35450eff777073f6026907084864cf)]:
  - @roll-agent/protocol@0.1.0

## 0.10.0

### Minor Changes

- [#172](https://github.com/steveoon/roll-agent/pull/172) [`9743f0b`](https://github.com/steveoon/roll-agent/commit/9743f0bdce77cff3fe10b79278d66193c86cefae) Thanks [@steveoon](https://github.com/steveoon)! - 为 `roll chat` Agent bootstrap 增加可配置的全局超时和端到端取消，确保超时或 Engine
  关闭时停止排队任务、取消在飞连接，并在返回部分 catalog 前释放新建连接与使用租约。

### Patch Changes

- [#171](https://github.com/steveoon/roll-agent/pull/171) [`78150ab`](https://github.com/steveoon/roll-agent/commit/78150aba296181536017a14a9b172a2484202f2c) Thanks [@steveoon](https://github.com/steveoon)! - 在 `roll chat` 启动时按注册顺序有界并发初始化 Agent，缩短多 Agent catalog bootstrap
  耗时，同时保持稳定 Tool ID、告警顺序和单 Agent 失败隔离。

## 0.9.0

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

## 0.8.0

### Minor Changes

- [#163](https://github.com/steveoon/roll-agent/pull/163) [`692b351`](https://github.com/steveoon/roll-agent/commit/692b351d91dad93909971cff8c1bcf641db562a5) Thanks [@steveoon](https://github.com/steveoon)! - Strengthen `roll chat` with resource-aware batch tool scheduling, typed three-layer tool results, bounded context-overflow replay, and direct explicit Skill preloading scoped to the active Turn with reference-only persistence. Durable Tool evidence now uses bounded write-time-redacted projections, automatic per-thread retention, and explicit Raw RPC authorization. Add atomic V2 compaction checkpoints with V1 compatibility, transcript recovery, provider-portable schema-constrained semantic drafts, user-only destructive transitions, structured constraint revocation, exact model-facing evidence excerpts, bounded evidence batches and watermarks, and deterministic hard-bounded checkpoint reminders. Semantic state is the validated V2 recovery fact source; compatibility goal/constraint projections must match it, and the state is injected once per Turn instead of duplicating derived summaries in active history. Legacy V1 active snapshots migrate only as low-confidence uncertainties, are atomically archived as redacted paginated transcript evidence, and remain untouched when the first V2 reminder cannot expose every migrated fragment. Also add a fail-closed capability manifest, safe debug snapshots, and a real Ink PTY performance harness with optional fail-closed baseline comparison.

  Without a durable transcript store, legacy V1 checkpoints now remain active instead of being upgraded into V2 state whose source evidence could not be recovered.

  Keep explicit Skill bodies scoped to the active turn, and persist only lightweight Skill references. Bound and redact durable Tool evidence, prune it by age and per-thread quota, and require explicit host authorization before JSON-RPC clients can request the retained raw/input projection.

  Stream provider reasoning into a separate, non-persisted Ink thinking block and show responsive per-phase turn status above the prompt without conflating model wait, reasoning, reply, or tool activity.

  Make schema-constrained compaction configurable through `runtime.compaction.timeout-ms`, `runtime.compaction.max-output-tokens`, and an optional `runtime.compaction.thinking-level` override. Compaction now defaults to a 120-second provider budget and 8192 output tokens, inherits the runtime thinking level through AI SDK's unified reasoning semantics where supported, keeps Qwen's required structured-output thinking override, reports phase timings in verbose mode, and recognizes xAI's non-streaming output-limit response without weakening fail-closed history and checkpoint semantics.

### Patch Changes

- [#163](https://github.com/steveoon/roll-agent/pull/163) [`7a14d26`](https://github.com/steveoon/roll-agent/commit/7a14d2667e2bc92297279ea64d415f61e8c68236) Thanks [@steveoon](https://github.com/steveoon)! - Add native xAI Grok model support, including configuration setup, the `grok-4.5` 500k context window, reasoning effort, and visible reasoning summaries in `roll chat`.

  Keep nested `roll` commands on the same CLI instance that launched Chat, so development sessions no longer cross over to an older globally installed release. Preserve completed steps and redacted tool progress when a turn is interrupted, and replace technical cancellation notices with user-facing status copy.

- [#163](https://github.com/steveoon/roll-agent/pull/163) [`ade7265`](https://github.com/steveoon/roll-agent/commit/ade7265993a3755795e7c46f86119818aa5c9874) Thanks [@steveoon](https://github.com/steveoon)! - Fail closed when shell auto-approval cannot prove filesystem or executable containment: canonicalize existing paths, accept only exact common flags, reject unresolved glob and symlink-following reads, bind known-safe execution to a fixed POSIX shell and system `PATH`, and carry one admission snapshot through locked revalidation and execution. Require confirmation for Git and custom executables.

## 0.7.1

### Patch Changes

- [#146](https://github.com/steveoon/roll-agent/pull/146) [`d5cfdd0`](https://github.com/steveoon/roll-agent/commit/d5cfdd051110b58d4ab46ea0656ceb6316f9b3bf) Thanks [@steveoon](https://github.com/steveoon)! - Make `roll__skill` tolerate empty and main-document reference aliases so models can reliably load
  the primary `SKILL.md`, while preserving the existing references directory sandbox.

## 0.7.0

### Minor Changes

- [#142](https://github.com/steveoon/roll-agent/pull/142) [`99bab1b`](https://github.com/steveoon/roll-agent/commit/99bab1b2f4ec3f1ade87a3024abd3197d7a4d05a) Thanks [@steveoon](https://github.com/steveoon)! - 在 Windows PowerShell 7+ 上启用 `roll chat` 会话式长命令执行，新增有界的 `exec_list`
  恢复入口，并补全跨轮轮询、本轮 Esc 中断、轮超时保活与可等待的关闭清理语义。
  无法确认进程树已清理的会话会显式返回 `cleanup-failed`，并在读取该终态前继续占用会话名额。

## 0.6.0

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

- [#140](https://github.com/steveoon/roll-agent/pull/140) [`62ff3f9`](https://github.com/steveoon/roll-agent/commit/62ff3f9e00115f93bb0a2becf0f214636932decb) Thanks [@steveoon](https://github.com/steveoon)! - MCP Sampling 复用 `runtime.thinking-level` 全局配置：子 Agent 借用指挥官 LLM 推理时（`roll ask` / `roll run` / `roll chat`），reasoning/thinking effort 使用同一档位映射。
  - `resolveLLMCall` 对 `sampling` purpose 注入与 `chat` 相同的 `thinkingProviderOptions`；`ask` / `run` 构造 sampling model 改走统一解析入口。
  - `ConversationEngine` 把初始档位传给子 Agent Sampling；Ink TUI 的 `/think`、`/effort` 与快捷键切档后，主会话和已缓存 MCP 连接的后续 Sampling 请求同步更新，新接入 Agent 也使用最新档位。
  - Sampling 严格保留子 Agent 请求的 MCP `maxTokens` 上限，不会为了 provider thinking budget 静默扩大答案长度。
  - 行为变化：Sampling 此前不带 thinking 配置（走 provider 默认），现在默认跟随配置档位（默认 `medium`；Qwen 为 `enableThinking + 8192 thinkingBudget`）。如需关闭，设 `runtime.thinking-level: off` 或在交互会话中执行 `/think off`。

## 0.5.0

### Minor Changes

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

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`ea76679`](https://github.com/steveoon/roll-agent/commit/ea76679d8c390570b7baffef507579bda2058eb5) Thanks [@steveoon](https://github.com/steveoon)! - `roll agent install` 同名冲突改为显式授权替换，防止静默覆盖本地/Git 来源的 Agent 注册。
  - 同名 Agent 已通过 `local-path` / `git` 等非 npm 来源注册时，安装默认失败并给出两条出路：`roll agent remove <name>` 或新增的 `--force` 标志（确认风险后替换为 npm 安装）
  - catalog 短名安装在 npm download 前预检冲突，零副作用提前失败；非 catalog 包在 discover 后拦截，并清理本次新建的安装目录，不留孤儿目录（既有目录如 npm 升级场景不受影响）
  - `roll setup` 向导对「已通过其他来源注册」的官方 Agent 维持替换语义（选项文案已明示），自动授权替换；chat 会话内 `roll__agent_install` 不授权替换，冲突时如实返回失败原因与终端处理指引
  - 替换在线 core-managed 旧 Agent 且新版本未随即启动（缺必填 env 或 `--no-start`）时，优雅停止旧进程并将注册状态归位 idle，不再遗留运行旧代码的孤儿进程；setup 阶段失败同样停止旧进程
  - 修正 `roll agent install --start` 帮助文案与默认语义相反的问题（默认自动启动，`--no-start` 跳过）

## 0.4.0

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

## 0.3.0

### Minor Changes

- [#128](https://github.com/steveoon/roll-agent/pull/128) [`2089a38`](https://github.com/steveoon/roll-agent/commit/2089a3878096b366f75e25f55b4c9f342bb50ed8) Thanks [@steveoon](https://github.com/steveoon)! - 升级 AI SDK 至 v7 线，新增 claude-sonnet-5 支持。
  - **依赖升级**：`ai` ^6.0.154→^7.0.9、`@ai-sdk/provider` ^3.0.8→^4.0.1、`@ai-sdk/anthropic` ^3.0.68→^4.0.4、`@ai-sdk/openai` ^3.0.52→^4.0.4、`@ai-sdk/deepseek` ^2.0.29→^3.0.2、`@ai-sdk/alibaba` ^1.0.17→^2.0.3。zod 保持 v3 不变。
  - **claude-sonnet-5**：新版 `@ai-sdk/anthropic` 完整识别 `claude-sonnet-5` / `claude-opus-4-8` / `claude-fable-5`（128k maxOutputTokens、结构化输出、adaptive thinking）；旧版会将其降级为未知模型（4096 tokens、无结构化输出）。
  - **类型跟随**：provider 接口 `LanguageModelV3`→`LanguageModelV4`、`SharedV3ProviderOptions`→`SharedV4ProviderOptions`；`ToolCallOptions`（已移除）→`ToolExecutionOptions<unknown>`。均为类型层面机械迁移，运行时行为不变。
  - **adaptive thinking 识别修复**：`claude-sonnet-5` / `claude-fable-5` 等无 minor 版本号的 model id 此前匹配不上版本正则，误走 `thinking: enabled + budgetTokens` 导致 API 400（该系模型仅接受 adaptive）；现已兼容无 minor 及带日期后缀的 id，日期段不再被误判为 minor 版本。

- [#128](https://github.com/steveoon/roll-agent/pull/128) [`2089a38`](https://github.com/steveoon/roll-agent/commit/2089a3878096b366f75e25f55b4c9f342bb50ed8) Thanks [@steveoon](https://github.com/steveoon)! - 用量统计精度提升与 qwen think 标签泄漏修复。
  - **context window 表**：补 `claude-sonnet-5` / `claude-opus-4-7` / `claude-opus-4-6` 条目（均 1M，依据官方模型文档）。此前 `claude-sonnet-5` 落到通用 `claude` 兜底 200k，状态栏余量低报 5 倍。
  - **SessionTokenUsage** 新增 `cacheWriteTokens`（映射 AI SDK v7 `inputTokenDetails.cacheWriteTokens`，session 累计同步）；`message-finish` 事件新增 `outputTokensPerSecond`（取自 v7 finish-step performance stats）。
  - **状态栏**：`in` 段显示 cache write（`(+800 cached, +200 cache-write)`）；新增 `· N tok/s` 输出吞吐段。
  - **状态栏响应式两档**：按终端宽度自适应——宽度足够显示完整标签（`turn in … (+cached) out …`、`session …`、`(90% left)`）；不足时切紧凑档（`↑215.2k ↓307`、`Σ374.5k`、`43t/s`、ctx 去掉百分比括号）；仍不足按 tok/s → session → turn → think 优先级丢段，model 与 ctx 永远保留，不再出现中段截断。`formatTokens` 支持 M 单位并去除尾零（`1000.0k`→`1M`、`200.0k`→`200k`）。
  - **think 标签泄漏修复**：qwen 等模型将 `<think>` 推理内联在文本流中，当 thinking 跨越工具调用时开/闭标签被分到不同历史段，导致 `</think>` 字面量泄漏、推理文本按正文亮色渲染。`parseThinking` 兜底处理无开标签的闭标签；流式状态机跨段携带 think 开闭状态（提交时补 `<think>` 前缀，live 区同步）。

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
