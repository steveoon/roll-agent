# @roll-agent/runtime

## 0.20.0

### Minor Changes

- [#249](https://github.com/steveoon/roll-agent/pull/249) [`937dc42`](https://github.com/steveoon/roll-agent/commit/937dc423fc47cc5ea5bc69fb0e6382c849695467) Thanks [@steveoon](https://github.com/steveoon)! - `roll chat` 新增 `/model`，在配置里声明的 provider/model 间实时切换
  - 配置新增 `llm.providers.<provider>.models`（可选）；`/model` 列出所有已配置 key 的 provider：默认模型、`models` 列表、以及无列表时的内置默认模型；支持 `/model provider/model` 直达
  - 切换作用于本次 roll chat 进程（含 `/resume` 切到的会话），同步 thinking providerOptions、compaction 结构化输出参数、context window、子 Agent sampling 模型与线程 `model` 字段；任一会话正在生成回复时整体拒绝切换，不会留下半切换状态
  - 切换后可选「同时设为默认 LLM」写回 `roll.config.yaml`：写入 `llm.default-provider` / `llm.default-model`，并清除会覆盖它们的 `runtime.provider` / `runtime.model`，保证下次 `roll chat` 与定时任务真的用上新默认
  - 定时任务与 `roll ask` 等不受影响，始终使用配置默认值
  - runtime 新增 `AgentSession.switchModel()` / `canSwitchModel()`、`ConversationEngine.switchModel()`、`ThreadStore.updateModel()`；core 的 `McpClientManager.setSamplingModel()`
  - 基础 REPL（非全屏）暂不支持 `/model`，会给出提示

- [#249](https://github.com/steveoon/roll-agent/pull/249) [`c1dcf28`](https://github.com/steveoon/roll-agent/commit/c1dcf28584b76879be53e6831f723b14fbe64b3c) Thanks [@steveoon](https://github.com/steveoon)! - 模型 context window 改为按 models.dev 官方目录解析，不再依赖内置子串表
  - runtime 新增 `ModelCatalog` / `resolveModelContextWindow()`：`runtime.context-window` 覆盖 → 目录官方 provider 条目（`limit.input ?? limit.context`，随包内置快照 + `~/.roll-agent/cache/model-catalog.json` 每日后台刷新）→ 内置家族规则；`ConversationEngine.switchModel()` 需要 `provider` 并返回解析结果与来源
  - `/model` 切换提示显示 `ctx` 与来源（模型目录 / 内置规则 / 配置覆盖）；gpt-5.6 系列、gemini-3.8 等新模型不再被识别成 400k
  - 新增 `pnpm catalog:refresh` 重新生成内置快照

- [#249](https://github.com/steveoon/roll-agent/pull/249) [`25561ef`](https://github.com/steveoon/roll-agent/commit/25561efb115c3b3897246f9f3ec0de45650d7750) Thanks [@steveoon](https://github.com/steveoon)! - Separate scheduled execution conversations from ordinary chat history. Add `/schedule` browsing,
  `roll schedule inspect`, and `roll chat --from-run` to inspect execution records and start a separate
  discussion from a committed snapshot using the current workspace configuration. Preserve run-to-thread
  associations across retries, task removal, and ledger retention, and conservatively classify legacy
  conversations with verified ledger links. Runtime conversation lists now exclude scheduled originals,
  which remain readable by ID and reject interactive continuation.

  Make snapshot continuation a prominent, labeled keyboard action that remains visible while scrolling
  and in narrow terminals, with explicit progress and unavailable states.

  Keep chat initialization read-only toward the scheduler and other workspaces. Scheduler-owned
  entrypoints backfill durable references; chat only classifies threads in its own store. Rebuild snapshot
  provenance as model-only system context, preserving genuine user history. Return raw status/mode enums
  from inspection JSON, with null and explicit reason codes when historical state is unavailable.

### Patch Changes

- [#249](https://github.com/steveoon/roll-agent/pull/249) [`b07f134`](https://github.com/steveoon/roll-agent/commit/b07f1348c86a809d7ec9105d5724e85607206a29) Thanks [@steveoon](https://github.com/steveoon)! - MCP 工具 schema 的本地 `$ref` 在消费边界统一内联，修复 Gemini 报「only supports references to direct children of root-level $defs」以及 preflight / `roll ask` 提参对 `$ref` 字段静默放行、丢类型的问题
  - `normalizeListedTools()`（chat / ask / run 共用）把非递归本地引用内联成语义等价的完整 schema：只遍历承载子 schema 的标准关键字，`const` / `enum` / `default` / `examples` 与扩展字段中的 ref-shaped 数据保持不透明；只合并注解型及 `$defs` / `definitions` 容器兄弟键，`$ref` 旁带校验关键字时不内联；递归、外部、目标不存在、带校验兄弟键、展开超限的引用保留原样并告警，挂在 `AgentTool.schemaIssues`；限额只针对引用展开，无 `$ref` 的 schema 不受影响
  - 会话层按 provider 判断残留引用能否接受（google 只接受根级 `#/$defs/<名>` 的递归引用，其余 provider 直接透传），不可接受的工具对模型不可见并告警；该判断在建会话、`/model` 切换 provider、会话中动态安装 Agent 三处统一重算
  - `buildAgentToolset()` 对直接构造的 `AgentToolSource` 做幂等防御内联，并保留 `schemaIssues` 供策略使用
  - `roll agent tools --json` 现在输出内联后的 schema（即模型与 preflight 实际看到的版本），不再原样透出 wire schema 里的 `$ref`
  - 新增公开 API：core `tool-runtime/json-schema-refs`（`inlineAcyclicLocalJsonSchemaReferences()`、`isRootDefinitionReference()`、`JSON_SCHEMA_REF_ISSUE_REASONS`）、`AgentTool.schemaIssues`、`normalizeListedTools(tools, { onSchemaIssue })` 与 `formatToolSchemaIssue()`、`providerAcceptsToolSchemaIssues()`；runtime `AgentSessionOptions.toolSchemaPolicy` / `onToolExcluded`、`SessionModelSwitch.toolSchemaPolicy`、`BuiltToolset.schemaIssuesByToolId`，以及导出的 `ToolSchemaPolicy`、`SessionToolExclusion` 类型

- [#249](https://github.com/steveoon/roll-agent/pull/249) [`15c8e59`](https://github.com/steveoon/roll-agent/commit/15c8e596f358130a4b55a41c4f5bf303f8c5d724) Thanks [@steveoon](https://github.com/steveoon)! - `ThreadStore` 构造函数新增可选 `{ now }` 时钟，仅用于 Runtime event / tool execution 保留策略的截止时间计算；修复一批以固定日期为 fixture 的保留策略测试随日历过期失败的问题

## 0.19.1

### Patch Changes

- [#244](https://github.com/steveoon/roll-agent/pull/244) [`ad2a96a`](https://github.com/steveoon/roll-agent/commit/ad2a96a80c0e403aede0a24ca12f86266444c475) Thanks [@steveoon](https://github.com/steveoon)! - 为后台任务增加 `~/.roll-agent/secrets.env` 配置占位符回退，并在 doctor、service install、Roll UI 与 chat schedule tool 中统一报告无法解析的变量。诊断不会携带 secret 明文；即使调度服务本身已经运行，任务创建结果仍会保留配置 readiness warning。

## 0.19.0

### Minor Changes

- [#239](https://github.com/steveoon/roll-agent/pull/239) [`63be2a8`](https://github.com/steveoon/roll-agent/commit/63be2a8c26d94aa0d200b6cbcb49fb4a0258649b) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 新增内建定时任务工具，自然语言即可创建定时任务：
  - `roll__schedule_create`：登记按固定间隔运行的任务；创建前以规范化对象展示完整参数与权限边界确认（批准一次只授权这一个任务），确认到创建之间配置 / 权限漂移则 fail-closed 放弃；相同定义（按有效单次上限比较）的 active 任务幂等返回既有记录，权限摘要不同时按新摘要重新授权并明示
  - `roll__schedule_list`：只读列出任务（分页、prompt 有界摘要、附调度服务就绪状态）；账本以真正只读方式打开（`readScheduleLedger`：不存在返回空、schema 不符拒读且绝不自动迁移）
  - 无人值守（定时任务触发的）轮次只注册 list、不注册 create——定时任务不能繁殖定时任务；system prompt 新增 `# 定时任务` 段与无人值守说明
  - `ScheduleStore` 新增 `createScheduleIdempotent`（事务内语义查重）；core 新增 `scheduler-host/schedule-tool-binding.ts` 端口——账本随会话配置、authority digest 按任务目录配置（与 `roll schedule add` 语义一致）、daemon/service 就绪探测——engine-factory 一处接线覆盖 chat / server / schedule-exec 三入口；core exports 仅新增 `./scheduler-host/schedule-tool-binding` 单条子路径

- [#239](https://github.com/steveoon/roll-agent/pull/239) [`185e363`](https://github.com/steveoon/roll-agent/commit/185e3634500c9c8c0313f11542be1354c3593a39) Thanks [@steveoon](https://github.com/steveoon)! - 新增 `roll schedule` 定时任务：按周期无人值守地运行一轮 chat。
  - runtime：`ScheduleStore`（SQLite，claim/lease/重试账本）、间隔触发解析、`UnattendedToolPolicy`（无人值守时 confirm 一律 deny）、`background` host mode 与来源标记（只进推理副本，不进历史）
  - core：`roll schedule add|list|show|remove|pause|resume|run-now|runs|cancel|status|daemon|service`；daemon 按触发 spawn `roll schedule exec` 子进程，每次触发最多尝试 3 次（首次 + 2 次重试），耗尽后自动 PAUSE 并在列表显示原因
  - 配置新增 `scheduler.data-dir` / `max-schedules` / `max-concurrent-runs`
  - 安全边界：exec 子进程记录 PID + OS 启动身份，lease 过期只在证实旧进程已退出后才重跑；登记时记录 `runtime.approval` / `runtime.shell` 权限摘要，漂移即暂停并要求 `resume` 重新授权；ownership token 与账本路径读取后立即从子进程 env 清除
  - 运维：daemon / service 显式固化 `--data-dir` 与 `--max-concurrent-runs`；停止时 10 秒 grace 后 SIGKILL（Windows 关闭控制台窗口时跳过 grace 立即强制终止）；单次运行超过 1 小时强制终止；运行记录按每任务 100 条 / 30 天保留；`--every` 上限 365 天；`run-now --inline` 单次尝试、失败退出码 1；`bin/roll` 对 `schedule` 自动启用 `node:sqlite`
  - 单例约束：同一任务同一时刻只运行一次（scheduled 与 manual 触发共用账本事务内门禁）；`roll schedule cancel <invocation-id>` 提供人工终态出口（运行中的记录必须 `--kill` 并确认 exec 进程退出后才释放单例，不可验证时只能显式 `--abandon`）；exec 以进程组运行，强制终止覆盖其后代进程（POSIX）
  - Windows：服务改为 XML 注册（不受 `schtasks /TR` 261 字符限制，无 72 小时运行上限，失败后自动重启，电池供电不影响），进程身份只走 SystemRoot / ProgramFiles 下的 PowerShell 绝对路径且超时放宽到 8 秒，daemon 停止时不再发送对控制台进程无效的 `taskkill /T`，exec 子进程在 Windows 也脱离 daemon 控制台；安装把实际 `data-dir` 以 `installing → installed` 两阶段写入用户目录下的稳定 service metadata，安装/卸载由跨 data-dir 文件锁串行化，设置未变化的重复 install 只刷新定义不卸载重装也不重启 daemon（任务处于 disabled 时先完成上次收尾），partial install 会 Disable/Stop；显式 `service uninstall` 先禁用 Scheduled Task，再持有 daemon lifecycle lock，按账本中的 daemon generation 原子作废未 begin 的 claim，并以 PID + 启动身份校验后 `taskkill /T /F` 收尾 running exec，任何未确认退出都保留 disabled 服务与 running 单例，inline worker 不受影响；权威账本必须含受支持 schema（空文件、无关 SQLite、更高版本都拒绝，热 journal 正常回滚），metadata 为 installed 但账本文件从未生成时直接删除任务，无 metadata 且无任务时 uninstall 幂等，metadata 缺失但任务仍在时错误里附人工恢复步骤；`run-now --inline` 在进程树终止未确认或后代仍存活时保留 `running` 而不释放单例；账本每个 claim 事务最多探活 1 个过期 running 行（名额按「最久未探活」轮转，探活时间持久化在账本列 `executor_probed_at` 里（schema 升到 v3，打开旧账本时就地补列），daemon 重启不丢；其余按 15 s 轮询间隔续租、下一轮再探），避免探活超时撑破 SQLite busy_timeout
  - POSIX：scheduled exec 收到取消、超时或 daemon 停止时先取消 active turn，让 Bash 自己清理独立进程组；grace 内未退出才升级 SIGKILL，避免遗留 shell 命令与重试并行；PID 启动身份不匹配时不会把新进程组误判为旧后代并终止；exec 被停止信号中断后不再自行写入失败结果，终态由 cancel / daemon / inline 发起方决定，`cancel --kill` 不会把最后一次 attempt 记成失败并暂停任务；macOS / Linux 没有 service metadata 时 install 会先 bootout 已加载的 LaunchAgent 再按当前配置重装、uninstall 按固定 label 卸载不依赖配置，macOS `service stop` / `uninstall` 在 `bootout` 后等待 launchd 真正卸载（最长 30 s）；`service status` 在 metadata 有效时容忍配置加载失败（附 `configError`，退出 0）；账本 schema 升到 v4（`tree_tracked_pgids` 存 `{ pgid, leaderState, startToken? }`，内部数字数组读成 `unknown`，旧 `{ leaderExited }` 对象与损坏 JSON 直接 fail-closed / `tree_unsettled` / `tree_survivor_pids`）；scheduled exec 在运行前与写入结果前会清理自己拉起的整棵进程树（Linux environ 标记 `ROLL_SCHEDULE_INVOCATION`、exec 进程组、内建 shell 每条命令的进程组，含 `&` / `nohup` 后台进程），SIGTERM 2 秒后升级 SIGKILL，清不干净则不写结果并保持 `running`，登记组写入账本随 retry 带走；macOS 的 `ps` 只取 pid / pgid / stat（不带 `-E`、不取 command），不读其他进程的 env 与 argv，已 setsid 离开进程组的进程是文档化边界（[#238](https://github.com/steveoon/roll-agent/issues/238)）；`cancel --kill` 会再清持久化树并以 attempt CAS 写账本，避免 stale cancel 覆盖新 owner；组外 survivor 不会因重试耗尽而 pause 并释放单例；`retry` + 未清树占同 schedule 单例；`pause` 不清空未清树的 invocation；`remove` 拒绝 live/未清树任务除非 `--abandon`；core-managed Agent 启动 env 剔离调度标记；从账本恢复的进程组必须用 start token 正向匹配才能发信号，token 缺失、验证不可用、或数字 PGID 的未知身份在 live leader 时不清场、不写终态；清场轮询中途身份不可验证时立即停止、不升级 SIGKILL，token mismatch 的 PGID 在整次 teardown 内保持隔离（首领恰在枚举瞬间退出不算复用，孤儿照常清理）；被未清进程树 hold 的运行在 `roll schedule runs` 带 `tree=unsettled(pid …)` 与原因、`roll schedule list` 行尾提示 `cancel --kill`；`cancel --kill` 对 pending 记录直接取消；账本树元数据损坏的错误点名 invocation id，survivors 列损坏只当空；Windows 不再为每条 shell 命令读取 OS 启动身份
  - 单次运行上限按任务设置：`roll schedule add --max-run <时长>`（60 秒 ～ 24 小时，缺省仍为 1 小时）写入账本 `schedules.max_run_ms`（schema 升到 v5，旧账本就地补列），daemon 的超时定时器与孤儿清理阈值都按任务上限判断；`list` 行尾与 `show / --json` 的 `maxRun` / `maxRunMs` 显示该值，触发日志带 `max-run=… ms`
  - 服务二进制过期检测：service metadata 记录安装时的 node 路径、roll CLI 入口与 roll 版本；`roll schedule service status` 新增 `binary` 段并在 node / 入口不存在（nvm 切换后常见）或版本不一致时告警；`roll doctor` 新增「Scheduler service」检查（路径失效 fail、版本过期 warn、未安装 ok）；`roll schedule status` 在已装服务但 daemon 未运行时提示去看 `service status`；旧 metadata 没有 `binary` 时报 unknown，重装后开始检测
  - `roll schedule service restart`：用用户级 admission lock 原子阻止新 claim、复核 `claimed` / `running` 与持树 retry，再按当前 roll 与配置重装；`--force` 中断 daemon-owned、允许 inline 继续。daemon 被 admission 拒绝领取时记一条可操作日志（恢复时再记一条，不逐 tick 重复），foreground 启动被拒的提示指向 `service status` / `service restart`。admission 拒绝区分「service metadata 阻塞」与「锁短暂忙」，后者不记日志也不算阻塞；`installing` 恢复路径同样尊重 live 门禁（只有 `--force` 才中断在跑任务）；`restart --force` 在旧服务停止后发现残留占用时改为告警并继续安装（非 force 时报错附 invocation id 与 cancel 命令）；`restart --json` 输出 `{ action, liveInvocations, reason? }`；POSIX 上 readiness 失败直接卸载半安装的 LaunchAgent；全新 install 不再被 inline 运行挡住；握手超时错误附 daemon 日志路径；`roll schedule status` 对 `installing` 也提示；`roll doctor` 对无法解析的 metadata 记 fail 并给出 uninstall/install 恢复步骤。替换意图持久化 old/target data-dir，claim 在拿锁后再次复核，metadata 损坏时 fail-closed；foreground daemon 启动与 replacement 使用同一锁顺序。新服务只有携带匹配 generation、取得 daemon lifecycle lock 并回写就绪记录后，metadata 才从 `installing` 进入 `installed`，OS 注册成功但进程未启动不再误报成功
  - `roll update` 更新 Agent 期间持有 scheduler admission lock（拿锁最多重试 10 次 × 250 ms，避免与 daemon 一次 tick 撞上就整个中止）；自更新后的服务重启改为 spawn 一个新进程执行 `roll schedule service restart --installed-settings --json`（沿用已安装 metadata 的设置、不读取当前配置，配置损坏也不影响自更新；`restart` 未安装时不再读取配置），避免旧进程内新旧模块混跑；自更新后释放 Agent maintenance guards，再保留已安装 metadata 中的 data-dir / 并发设置重启服务，不会按当前 cwd 配置改绑；有效的 `installing` intent 即使 OS service 已缺失也会继续恢复。重启失败计入 update 失败与退出码；有任务运行时只提示；`roll update --check` 报告服务固化的版本 / 路径漂移。Node 22.6–22.12 的 `doctor` / `update` 由启动器自动补 `--experimental-sqlite`

### Patch Changes

- [#239](https://github.com/steveoon/roll-agent/pull/239) [`af2dd3f`](https://github.com/steveoon/roll-agent/commit/af2dd3f021d2f8efaaf3745e7487db9fb833e6d0) Thanks [@steveoon](https://github.com/steveoon)! - roll ui 新增「定时任务管理」面板（与 Companion 分区平级）：
  - 服务卡片：安装 / 重启 / 卸载开机自启调度服务，显示 daemon 存活、数据目录、下次唤醒与固化二进制是否过期；未安装但有 active 任务、上次安装未完成（fail-closed）、binary 过期等状态给出警示
  - 任务列表：间隔、下次运行、上次错误、运行中标记；逐任务暂停 / 恢复（恢复按当前配置重新授权）
  - 最近运行：跨任务合并的运行记录，含状态、尝试次数、耗时与可展开的失败原因；排队中可取消，运行中提供「终止并取消」（等价 `cancel --kill`，需确认）；`--force` / `--abandon` 只在 CLI 提供
  - 新增 `/api/schedule/*` 路由（session + CSRF 约束与其余 API 一致）与 `RollUiScheduleController` 契约；`roll schedule cancel` 的核心取消逻辑提炼为 `scheduler-host/cancel-invocation.ts` 供 CLI 与 Web 共用，CLI 行为不变
  - 已安装 service 固化的 data-dir 与当前配置不一致时，面板顶部给出阻断性警告（旧目录任务仍会执行、下方列表与操作不涉及它们）
  - `ScheduleStore` 新增事务化 `resumeSchedule(id, digest)`；Web 与 CLI 的恢复操作改用它，任务被并发删除时如实报错而非假成功
  - 取消/恢复的结果提示保留 CLI 同款警告：Windows 后代进程无法验证时提示人工检查，恢复时提示权限已重新授权

- [#239](https://github.com/steveoon/roll-agent/pull/239) [`90abbe5`](https://github.com/steveoon/roll-agent/commit/90abbe5dce3928202d62ece03a68661254d7c947) Thanks [@steveoon](https://github.com/steveoon)! - 升级 AI SDK 生态依赖到当前 7.x 线的最新 patch 版本，并同步 MCP SDK。
  - `ai` ^7.0.9→^7.0.65、`@ai-sdk/provider` ^4.0.1→^4.0.7、`@ai-sdk/anthropic` ^4.0.4→^4.0.38、`@ai-sdk/openai` ^4.0.4→^4.0.41、`@ai-sdk/deepseek` ^3.0.2→^3.0.31、`@ai-sdk/alibaba` ^2.0.3→^2.0.32、`@ai-sdk/xai` 4.0.12→4.0.38
  - `@modelcontextprotocol/sdk` ^1.12.0→^1.30.0（core / runtime / sdk 三包同步）
  - lockfile 中 `@ai-sdk/provider` / `provider-utils` / `openai-compatible` 的重复传递版本收敛为单一版本；`zod` 保持 v3 不变
  - 随依赖带来的行为变化：`@ai-sdk/anthropic` 4.0.8 起 thinking-level=off 发送的 `thinking: { type: "disabled" }` 会真正下发给 API（旧版静默丢弃）；4.0.21 起 Anthropic 的 thinking tokens 计入 `reasoningTokens` 用量；`@ai-sdk/deepseek` 3.0.30 起支持 DeepSeek V4 Flash Vision Exp 的图片输入；`@modelcontextprotocol/sdk` 1.30.0 起 stdio 传输单条消息默认上限 10 MiB，超限会断开连接（streamable-http 不受影响）

## 0.18.1

### Patch Changes

- [#235](https://github.com/steveoon/roll-agent/pull/235) [`c84bc83`](https://github.com/steveoon/roll-agent/commit/c84bc833c3abc095540ebfbb2d27610b538778f1) Thanks [@steveoon](https://github.com/steveoon)! - Runtime Protocol 1.4 对齐修复
  - protocol：`projectRuntimeServerRequestCancelParams` / `projectRuntimeServerRequestParams` 改按 `RUNTIME_PROTOCOL_CAPABILITIES` 派生 wire 形状，修复 1.4 会话上 `runtime.serverRequest.cancel` 投影抛错、取消通知从未送达（待处理 `approval.request` / `userInput.request` 到期或取消后客户端得不到通知）；新增全版本矩阵回归测试
  - protocol：补齐 `@roll-agent/protocol/schema/1.4` 子路径导出（产物已存在但未导出）；新增 `fixtures/v1.4/*` 跨语言 golden fixture；新增 docs-sync 测试把协议文档钉到 `RUNTIME_PROTOCOL_VERSION`
  - runtime：`RuntimeClientRequestCoordinator` 取消通知投影失败时通过 `onDiagnostic` 上报而不再静默吞掉；补 1.4 取消通知回归测试
  - core：`roll runtime serve --stdio` / `roll chat --server` 构造 coordinator 时接上 `onDiagnostic` → stderr 告警；此前所有 coordinator 诊断（错 responder / 错 scope / 过期响应 / 无法投影的 interaction / 投影失败）在生产里都是静默的

- Updated dependencies [[`c84bc83`](https://github.com/steveoon/roll-agent/commit/c84bc833c3abc095540ebfbb2d27610b538778f1)]:
  - @roll-agent/protocol@0.6.1

## 0.18.0

### Minor Changes

- [#233](https://github.com/steveoon/roll-agent/pull/233) [`badfaa0`](https://github.com/steveoon/roll-agent/commit/badfaa0dcd51a4355418a6e0684c4e7be5e2b0d7) Thanks [@steveoon](https://github.com/steveoon)! - feat(runtime): `roll__read_file` 支持读取图片文件
  - 通过 magic bytes（PNG/JPEG/GIF/WebP 文件头签名）识别图像，命中后以 base64 图像内容（content model output 的 file part）进入模型上下文，自动复用现有的工具图像搬运（`relocateToolImagesToUserMessages`）与「保留最近 2 张」老化策略
  - 补齐了「工具截图落盘后模型无法回读」的能力缺口：browser-use 等流程存到磁盘的截图，现在可由模型直接 `read_file` 载入识别
  - 图像分支只接管文本路径本就拒绝的文件（含 NUL 字节）：以 `GIF89a` 等签名开头的合法 UTF-8 文本仍走文本路径、照常可编辑，不会被误当图像
  - 各格式做完整性尾校验（PNG IEND / JPEG EOI / GIF trailer / WebP RIFF 尺寸），截断或损坏的图像显式拒绝，不会进入上下文毒化会话
  - 新增 `maxImageFileBytes` 设置（默认 5MB，对齐主流 provider 单图上限），超限图像与无签名二进制文件仍显式拒绝，文本路径行为不变（edit/write/verify 工具不受影响）
  - 压缩器 token 估算对消息中的 file part 改按固定常数计（原按 base64 字符长度折算，读入大图会虚估出数十万 token，触发虚假 context-pressure 压缩把图立即挤出上下文）
  - 图像读取忽略 `offset`/`limit`，工具描述已注明

### Patch Changes

- [#233](https://github.com/steveoon/roll-agent/pull/233) [`a842b51`](https://github.com/steveoon/roll-agent/commit/a842b51e1e5b5a51b21fd0a81f484ad2c319f236) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 输入解析修复：以文件路径等非命令形状开头的消息不再被误判为 slash 命令
  - 只有命令形状的首 token（`/` + 字母/数字/连字符）才进入 slash 命令/skill 解析；`/Users/...` 这类路径开头的输入按普通消息发送，TUI 层与会话层（explicit skill context）行为一致
  - skill 前缀后跟路径参数（如 `/some-skill /path/to/file 请求`）不再误报「未知 skill」，路径正确归入 prompt
  - `/` 弹窗过滤支持子串命中（如 `/zhipin` 命中 `/roll-zhipin-unread-reply`），前缀命中优先排序
  - 未知命令提示后保留输入草稿，便于修正拼写；输入命令参数时不再渲染空的「无匹配命令」弹窗

## 0.17.1

### Patch Changes

- [#230](https://github.com/steveoon/roll-agent/pull/230) [`3327d20`](https://github.com/steveoon/roll-agent/commit/3327d20ff7e1fdedde3e037cb4fc60a1b89c6292) Thanks [@steveoon](https://github.com/steveoon)! - 上下文窗口表识别 grok-4.6（500k）；此前该模型查表无命中，引擎拿不到窗口大小

- [#230](https://github.com/steveoon/roll-agent/pull/230) [`d95e872`](https://github.com/steveoon/roll-agent/commit/d95e87230ea77bfd881acefc24496d31df6d89b8) Thanks [@steveoon](https://github.com/steveoon)! - 模型流错误为非 Error 对象（provider 纯 JSON payload）时，错误信息优先取 message 字段、退回 JSON 序列化，不再渲染成 [object Object]

## 0.17.0

### Minor Changes

- [#228](https://github.com/steveoon/roll-agent/pull/228) [`f5a9804`](https://github.com/steveoon/roll-agent/commit/f5a98040522d7b0adb5d39821e35e1f2fb8047a6) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 编辑文件时展示 diff 视图（审批前预览 + 应用后变更）
  - runtime：`edit_file` / `write_file` 在审批前对编辑做 dry-run，把「改前 vs 改后」的 unified diff（含 `+N −M`）随审批请求一起投影；`edit_file` 对输入本身无效的编辑（`old_string` 与 `new_string` 相同等）在弹审批前直接失败，`edit_file` / `write_file` 对工作目录外路径在策略 / 审批门之前不再触碰文件系统。执行阶段会重算 diff，若增删行与审批时预览的不一致（例如同批次里 `write_file` 先改写了同一文件）则拒绝写入。写入成功后的 `display` 变为 `{ text, diff }`，模型可见输出保持原快照文本不变（含原有 60k 截断）。diff 由内置行级 Myers 生成，正文按上限截断、超大文件只给统计，计算失败不影响写入。注意：工具台账对 `display` 的 32 KiB 上限现在把 diff 计入，超大编辑快照被整体省略的阈值相应前移。
  - protocol：新增 `fileChangeDiffSchema` / `fileChangeDisplaySchema` 与 `getApprovalDiffPreview()` / `getFileChangeDisplay()`；diff 放在 `approval.preview.diff` 与 `tool.completed.display` 既有 JSON 槽位内，1.0–1.4 顶层 strict schema 不变，旧客户端忽略即可。
  - core：Ink TUI 审批框内嵌 diff 预览（按行预算截断，替代原始 edits JSON），对话流在工具行下渲染着色 diff；超过 40 行默认折叠为一行摘要，`/diff [on|off]` 会话级切换；基础 REPL 在审批消息与结果后打印着色 unified diff，同样支持 `/diff`。
  - core（diff 呈现）：单列行号（上下文 / 新增取新行号，删除取旧行号）、不再显示 `@@` hunk 头（多 hunk 之间用淡色 `⋯`）、配对的删除 / 新增行做 token→字符级差异并以反色标出改动片段（差异过大时退回整行着色）；审批框、对话流、REPL 共用同一行模型；有 diff 的工具行不再重复 args JSON。
  - core（TUI 排版修复）：带前缀的行（markdown 列表 / 引用、用户输入、notice / error、推理头、活动工具行）不再因 Yoga 按比例收缩前缀而多出一列——此前长行末尾会溢出一个字符到下一终端行、`▌ ` 后的空格会丢失；diff 块长行换行后续行与正文列对齐；工具行 args 单行截断不再整体掉行；markdown 表格按可用宽度整数缩放列宽、分隔线随列宽、折行时保留列间距。

- [#228](https://github.com/steveoon/roll-agent/pull/228) [`5ba685c`](https://github.com/steveoon/roll-agent/commit/5ba685cce832687b60c5abc49d6304e74352165c) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 自动注入工作区 AGENTS.md / CLAUDE.md 作为工程约定（[#222](https://github.com/steveoon/roll-agent/issues/222)）
  - runtime：新增 `workspace-instructions.ts`，从工作目录逐级向上找最近一层 `AGENTS.md`（优先）/ `CLAUDE.md`，`AgentSession` 每轮按 mtime/size 检查变化并重编译 system prompt；内容以 `# 工作区工程约定` 段注入（标注来源路径），不在消息历史里、不受 compaction 影响；超过 32 000 字符截断并通过 issue 回调告警一次
  - runtime：`ConversationEngine` 新增 `workspaceInstructions`（显式 source 或 `null` 关闭）与 `onWorkspaceInstructionsIssue` 选项，`getContextSummary()` 暴露 `instructionsPath`
  - core：新增配置 `chat.instructions: auto | off | <path>`（默认 `auto`，路径支持 `~`）；`roll chat` 把截断 / 缺失告警写到 stderr，banner 显示已加载的约定文件名；README 与 config guidance 同步

### Patch Changes

- [#228](https://github.com/steveoon/roll-agent/pull/228) [`3e4e06b`](https://github.com/steveoon/roll-agent/commit/3e4e06b12b145c3ca29691904ff55ad591e39f90) Thanks [@steveoon](https://github.com/steveoon)! - 中断终态写入统一以工具账本为门，暂停路径补齐账本写入，溢出文案改由账本执行状态派生
  - `appendInterruptedTurnMessages` 新增账本门：`pendingToolCalls` 仍有未入账调用时拒绝写入任何中断终态并上报错误，使「先账本、后终态」从四条中断路径各自的纪律变成漏斗处的结构性约束
  - `persistPausedTurnCancellation`（轮内压力暂停）此前是唯一不经 `persistPendingToolCancellationsOrReport` 就写终态的中断路径，现与其余三条对齐：账本写入失败即中止，以降级文案上报取消
  - 上下文溢出标记的「本轮已有操作开始执行」提示改由账本记录的执行状态派生：仅宣告即取消（`executionState=not_executed`）、策略拒绝、用户拒绝、输入校验失败的调用不再触发该提示，散文与同批持久化的账本证据不再互相矛盾

- [#228](https://github.com/steveoon/roll-agent/pull/228) [`e7d2b15`](https://github.com/steveoon/roll-agent/commit/e7d2b157efd3c5f87226852991e35c77aea9a91f) Thanks [@steveoon](https://github.com/steveoon)! - 上下文溢出中断路径在工具账本写盘失败时 fail closed，不再落盘误导性终态

  `persistContextFailure` 此前丢弃了 `persistPendingToolCancellationsOrReport` 的返回值：当模型宣告 tool call 后触发 `context_length_exceeded`，而 Tool ledger 写入同时失败（磁盘满、存储约束等）时，pending 调用的取消记录没有进账本、也没有留下 uncovered 标记，但本轮仍会把「本轮已有操作开始执行，部分结果可能已经生效」的中断终态写进 transcript。结果是一条没有任何法医记录支撑的终态，且下一轮不会 fail closed。

  现在该路径与另外两条中断路径（`persistFailedTurn`、`persistCancelledTurn`）行为一致：账本写盘失败即中止，不写终态，内存已由调用方回滚到 turn 起点，账本失败与溢出错误两个事件仍照常上报。

- Updated dependencies [[`f5a9804`](https://github.com/steveoon/roll-agent/commit/f5a98040522d7b0adb5d39821e35e1f2fb8047a6)]:
  - @roll-agent/protocol@0.6.0

## 0.16.0

### Minor Changes

- [#225](https://github.com/steveoon/roll-agent/pull/225) [`470e4fc`](https://github.com/steveoon/roll-agent/commit/470e4fcffffb4ed21c0f849cee7c011e7b0b715d) Thanks [@steveoon](https://github.com/steveoon)! - roll**bash 新增 `max_output_chars`（整数，1000-200000，默认继承 `runtime.shell.max-model-output-chars`）按调用控制模型可见输出量。输出被中段截断时，标记只陈述事实（截掉多少、保留前后各多少字符、全文多长）；发生截断时完整输出落盘到 `~/.roll-agent/bash-output-dumps`（目录 0700、文件 0600，按 24 小时 / 32 个文件收敛，exec_command 会话单文件上限 4MB），并由能兑现的层（roll**bash 结果、exec_command 轮询结果）给出「用 roll**read_file 以 offset/limit 分页查看中段，或重跑更窄的命令」的恢复指引；roll**read_file 读取该目录不再触发工作区外审批。

- [#221](https://github.com/steveoon/roll-agent/pull/221) [`d614672`](https://github.com/steveoon/roll-agent/commit/d614672efe38b27e4c7d04b0c5fc6361c43ee6ca) Thanks [@steveoon](https://github.com/steveoon)! - roll chat coding 工具扩展：roll**grep / roll**glob（ripgrep 后端，输出与 read/edit 契约耦合，全角标点归一化提示）、roll\_\_verify_file（多语言验证器注册表，fast/project 分级，fail-honest；会执行项目本地代码的验证器如 eslint 需确认一次）、会话级批准记忆（确认弹窗在可记忆时提供「允许并本会话不再询问」，仅进程内 Ink TUI；不改 wire 协议）、write_file 缩水防护与 edit→write 导流。

- [#221](https://github.com/steveoon/roll-agent/pull/221) [`aa14d16`](https://github.com/steveoon/roll-agent/commit/aa14d16f1c1f5c494f2d8f7a88d5f6b05c290175) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 新增内建文件工具：roll**read_file / roll**edit_file / roll**write_file / roll**list_dir。按状态同步协议设计——read-before-edit 与内容 hash stale 检测、Unicode 归一化容错匹配（全角标点/智能引号/CRLF）、失败返回最近似位置与差异诊断、批量 edits 原子落盘、成功返回编辑点快照免二次读取。默认启用，可用 ConversationEngineOptions.fileToolsEnabled=false 关闭。

- [#225](https://github.com/steveoon/roll-agent/pull/225) [`05d8090`](https://github.com/steveoon/roll-agent/commit/05d80905cb2df6afd56fef70c093cdd1ba8537d3) Thanks [@steveoon](https://github.com/steveoon)! - roll chat 自动压缩触发机制重做（对齐 Codex / grok-build 的做法）：上下文压力 = 上一次真实 usage + 之后追加内容的估算，恢复会话或尚无实测时按历史估算——`/resume` 后第一条 prompt 也会触发压缩；触发后压缩必须真正减少上下文：`targetTokens` 超出时先放弃 `keep-recent-turns` 保护按目标预算保留整轮，最近一轮单独超出时在步骤边界切并保留该轮 user 消息（tool 调用/结果对不拆），最多连续 4 轮压缩直到低于阈值；轮内每个步骤后也检查压力，超阈值时暂停当前轮、压缩、并在同一个 send 内自动续跑（最多 2 次），长编码轮不再一路涨到 provider 报错。内置模型表补 `qwen3.8-max` / `qwen3.8-plus`（1M）。轮内压缩不截断最后一个步骤的工具结果（模型续跑正需要它）；暂停后无论压缩是否有进展都在同一个 send 内续跑，压缩无进展时不再重复暂停。手动 `/compact` 保持原有 `keep-recent-turns` 语义（不按目标预算升级切法）；续跑与首段共享 `runtime.max-steps` 步骤预算；轮内压缩期间被取消会发出 turn-cancelled 并持久化与取消轮一致的恢复记录与取消标记（resume 后知道本轮已停止、哪些工具副作用已发生），压缩报错会以 error 事件收尾且不回滚已持久化的前半段；RuntimeService 不再在首段 message-finish 时锁定 turn.completed，压缩阶段的失败 / 取消如实以 turn.failed / turn.cancelled 收尾。用户拒绝工具的那一步即使压力超阈值也不会暂停压缩后续跑，reject 仍然结束本轮。注入到最后一条 user 消息前的 compaction checkpoint reminder 计入压力与目标预算（学习到的 prompt overhead 剔除它、按当前 reminder 加回），`/resume` 后首轮估算不再漏掉这部分上下文。

### Patch Changes

- [#225](https://github.com/steveoon/roll-agent/pull/225) [`470e4fc`](https://github.com/steveoon/roll-agent/commit/470e4fcffffb4ed21c0f849cee7c011e7b0b715d) Thanks [@steveoon](https://github.com/steveoon)! - roll**bash / exec_command 的管道成败改为逐段退出码判定：末段为 0 且其余各段为 0 或被下游提前关闭（SIGPIPE / 141）才算成功——`git log | head` 型预览不再假失败，`false | true`、`pnpm test | tail` 如实报失败；逐段状态与 shell 退出码不一致时以退出码为准。bash / zsh 通过 EXIT trap 采集逐段状态；拿不到逐段状态的 shell 退回 pipefail（141 标注为上游提前关闭、不视为失败），两者都不支持时保持末段退出码语义。系统提示只陈述运行时探测到的管道能力，不再鼓励自接 head/tail 管道，改为引导使用 `max_output_chars` 或 roll**read_file / roll\_\_grep。

- [#225](https://github.com/steveoon/roll-agent/pull/225) [`3857487`](https://github.com/steveoon/roll-agent/commit/3857487489b741e822f0f8b2892b4d8446f049e0) Thanks [@steveoon](https://github.com/steveoon)! - 数值边界参数统一由 boundedIntParam 从同一份 min/max 派生 JSON schema 边界与描述文字（bash 的 timeout_ms/max_output_chars、exec 的 yield_time_ms/max_output_tokens、grep 的 context/max_results），模型第一次调用即知范围；越界/类型错误在 prepare 与 AI SDK tool-error 归一的唯一入口经 describeZodIssues/friendlyInvalidToolInputMessage 生成一句话友好文案（参数名、允许范围、所传值），不再吐 zod 原文；read_file 等工具的 prepare 参数校验同样走共享友好格式化。

- [#225](https://github.com/steveoon/roll-agent/pull/225) [`bfc7468`](https://github.com/steveoon/roll-agent/commit/bfc746845439284f652fbde04e8179d71e21c46c) Thanks [@steveoon](https://github.com/steveoon)! - 模型调用在多步 turn 中途失败（限流 / 网络中断 / 5xx 等非上下文溢出错误）时不再把整轮从会话历史里抹掉：已完成的工具调用与结果、在途工具的账本记录、一条 runtime 恢复记录（`roll__interrupted_turn_recovery`）和失败说明会像取消路径一样持久化；首次调用就失败、没有任何进展的 turn 仍保持干净重试。取消 / 暂停后取消 / 上下文溢出 / 运行错误四条中断路径共用同一套追加与回滚实现，并以 ActiveTurn 的 segment 水位决定追加范围。已落盘的 user 和工具步骤不会重复；下一轮 prompt 中仍保留的 raw tool-call/result 至多一组且始终成对，被合法压缩裁掉的步骤由 checkpoint 或 recovery evidence 承接。

  工具是否已经开始执行改为按每个模型 batch 的 occurrence 身份跟踪，不再把 provider 的 `toolCallId` 当成整轮唯一键。跨 step 或压力续跑复用同一 ID 时，新宣告但尚未执行的调用会准确记录为 `not_executed`；真正越过准入、锁与执行前复验边界后才记录为 `outcome_unknown`。恢复记录仍按可见 raw 结果的出现次数消费同 ID 账本，第二次执行不会被第一次的结果遮蔽。

  ThreadStore schema v6 将工具账本升级为可恢复的 semantic WAL：每条新 `ToolExecutionRecord.id` 在 ledger 写入后保持 uncovered，直到 raw transcript 或 bounded recovery evidence 与 exact coverage 在同一 SQLite 事务提交。正常 segment、运行错误、取消和上下文溢出都通过同一 coverage 协议关闭窗口；纯溢出也会保留 bounded evidence，但不把可能再次撑爆上下文的 raw 工具结果写回。若 transcript 提交失败或进程在 ledger 与 transcript 之间退出，下一次 send、手动 compact 或重建 session 的 resume 会先原子写入恢复记录再继续；恢复写仍失败时不会调用模型或工具。uncovered ledger 不受 retention 裁剪，旧 schema 的既有记录迁移为已覆盖，连续恢复保持幂等。

- [#225](https://github.com/steveoon/roll-agent/pull/225) [`60d16c4`](https://github.com/steveoon/roll-agent/commit/60d16c419158ed50bf1e64035d6f85ff1f3d6fb3) Thanks [@steveoon](https://github.com/steveoon)! - 文件工具文本协议收敛为「只拒绝原始 NUL（U+0000）」，读写对称：write_file 的 content、edit_file 的 old_string/new_string 含原始 NUL 或不成对的 UTF-16 代理项（lone surrogate）时在审批弹窗前以 invalid_input 拒绝并给出自救指引（JSON 双解码解释、双反斜杠转义文本、shell 生成原始字节）；read_file 的二进制探测改为扫描整个文件（不再只看前 8192 字节），且只以 NUL 判定，ESC/FF/VT/DEL 等控制字符视为文本，ANSI 日志类文件重新可读可写。修复 write_file 写入以 BOM 开头的 content 后 tracker 记录含 BOM 摘要、导致后续 edit_file 误报 stale 的问题（现按 BOM 文件落盘并记录去 BOM 内容）。仓库源码的 CI 控制字符守卫（scripts/check-source-control-chars.mjs）保持更严格的全 C0 规则，与文件工具运行时策略相互独立。

## 0.15.1

### Patch Changes

- [#213](https://github.com/steveoon/roll-agent/pull/213) [`6841eb5`](https://github.com/steveoon/roll-agent/commit/6841eb5b30694b36cb97863507aa9e0f61f00366) Thanks [@steveoon](https://github.com/steveoon)! - 附件栈发布后 review 修复：
  - `ATTACHMENT_QUOTA_EXCEEDED` 错误文案如实反映配额契约——附件被 `turn.start` 引用后不会自动释放，恢复路径是 `attachment.release` 或等待 TTL 回收（原文案声称引用可腾出槽位，与实现不符）
  - local-path stage 现在同时校验 `sourcePath` 的扩展名与申报 `mediaType` 一致，拒绝用合法 `fileName` 包装任意扩展名的本地文件
  - 工具图像搬迁消息改用 `providerOptions.rollRuntime.relocatedToolImages` 显式标记识别，替代「以下图像来自工具 」文本前缀启发式；以该前缀开头且携带图片的用户消息不再被 stale 修剪误伤

## 0.15.0

### Minor Changes

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`8549330`](https://github.com/steveoon/roll-agent/commit/85493304ac978f99889029f725e8f35ddf6a3301) Thanks [@steveoon](https://github.com/steveoon)! - chat 端到端图像链路：工具截图可直接被多模态模型识别
  - SDK：工具结果新增 `mcpImages` 约定字段（导出 `ToolResultImage` 类型），`executeToolForMcp` 将其摘出为 MCP 标准 image content block，base64 不再混入文本 JSON 载荷
  - runtime：tool result 中的 file part（图像）改走独立预算（`MAX_TOOL_MODEL_FILE_CHARS`，12M 字符），不再被 60k 文本预算截断——图像 token 成本按分辨率计算而非字符数
  - runtime：新增 `relocateToolImagesToUserMessages` 幂等消息变换，经 `streamText` 的 `prepareStep` 在每步请求前把 tool 消息中的图像搬运到紧随的 user 消息——dashscope 等 provider 对 tool 角色消息中的图按纯文本计入 input length，仅 user 消息中的图走视觉通道
  - browser-use-agent：`zhipin_capture_resume` 返回值携带 `mcpImages`，chat 模式下模型可直接看到简历截图（实测 qwen3.7-plus / grok-4.5 / gpt-5.5 皆可识别并继续调用工具）

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`38bb3c6`](https://github.com/steveoon/roll-agent/commit/38bb3c66dcd9090cf929b1eb6f85082839a2218f) Thanks [@steveoon](https://github.com/steveoon)! - Runtime Protocol 1.4：附件与二进制载荷引用（issue [#177](https://github.com/steveoon/roll-agent/issues/177)）
  - **protocol**：新增协议版本 1.4。`AttachmentDescriptor`（ID/文件名/安全展示名/MIME/字节数/sha256/来源）、`attachment.stage|chunk|commit|release` 四方法与 staging→committed→release 生命周期；`turn.start` 的 input 扩展 `attachments` 引用数组（纯附件可空文本）；八个稳定错误码（NOT_FOUND/NOT_COMMITTED/TOO_LARGE/TYPE_UNSUPPORTED/HASH_MISMATCH/QUOTA_EXCEEDED/UPLOAD_INCOMPLETE/PATH_REJECTED）；initialize limits 广播附件配额；`UiMessage` V14 新增 `attachment` 安全元数据 part，快照投影到 ≤1.3 时自动降级为 text-only；V13 及更早 schema 全部冻结不变，`turn.start` 携带 attachments 在 1.3 会话被 strict 拒绝
  - **runtime**：新增 `AttachmentStore`（staging 目录 + 内存状态机）：local-path 来源校验绝对路径/拒 symlink/大小与 sha256 匹配后一步 commit；chunks 来源按序追加（单 chunk ≤2MiB 原始字节，不突破 4MiB NDJSON 帧）、commit 时校验完整性与 hash，不匹配即回收；staged/committed 双 TTL 惰性回收、thread 删除联动清理、进程重启清扫孤儿文件；`RuntimeService` 注入 `attachmentStore` 后启用 attachments 能力，`turn.start` 解析附件引用为引擎 `SessionAttachment` 且客户端路径不落 thread；Thread Snapshot 返回附件安全元数据（mediaType/bytes），不含二进制与本地路径
  - **client-node**：协商版本联合扩展 1.4，事件重放与 recovery snapshot 在 1.4 会话可用；`request()` 通道从 Protocol 1.1 方法域升级到 latest 方法域——`attachment.stage|chunk|commit|release` 与带 `attachments` 的 `turn.start` 均可通过 `client.request(...)` 类型安全地调用（此前 V11 facade 会在类型层拒绝且 turnId 提取路径运行时崩溃）

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`540f530`](https://github.com/steveoon/roll-agent/commit/540f530cff10975736c4a66669fad59b6020b4cb) Thanks [@steveoon](https://github.com/steveoon)! - `AgentSession.send()` 支持图像/文件附件输入（TUI 粘贴、GUI/WebUI 附件闭环的引擎底座）
  - `send()` 签名扩展为 `string | SessionSendInput`（`{ text, attachments?: [{ data: base64, mediaType }] }`），纯字符串调用方零改动
  - 带附件时用户消息以 AI SDK parts 数组构造（text part 在前、file part 在后，空文本纯附件省略 text part），无附件时保持 string content，ThreadStore 持久化经 `modelMessageSchema` 原生兼容
  - 显式 Skill 上下文（`/<skill> 请求`）应用到带附件消息时只替换文本、保留 file parts，不再整体覆写
  - compaction evidence 渲染前统一脱敏内联二进制：用户消息 file/image part 与 tool-result 输出中的图像 base64 均替换为占位符，防止历史图像数据灌入 compaction prompt
  - 新增导出类型 `SessionAttachment` / `SessionSendInput`

### Patch Changes

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`5218a94`](https://github.com/steveoon/roll-agent/commit/5218a94269afc3a94fdbf341a7533c9fcd86c652) Thanks [@steveoon](https://github.com/steveoon)! - 简历工具链 code review 修复（8 项）
  - `zhipin_locate_resume_canvas` 改用轻量几何探测 `readResumeCanvasGeometry()`，不再跑完整滚动拼接（实测 ~20s → 0.5s），恢复 5s canvas 等待与结构化错误返回，`canvasInfo` 语义回归 canvas 缓冲区尺寸
  - `zhipin_capture_resume` / `zhipin_open_resume` 补 catch：CDP 中途异常不再泄漏为 raw MCP 错误，visual 反馈以 error 态收尾而非永久残留「正在读取」胶囊
  - `zhipin_capture_resume` 的弹窗等待预算 3s → 12s，与 `zhipin_open_resume` 对齐，消除慢网下的过早失败
  - 关闭按钮搜索限定在可见 dialog 容器作用域内（`.close-btn` 等通用选择器不再可能命中主文档无关元素）
  - 弹窗关闭判定加入 iframe 可见性（站点隐藏而非卸载弹窗时不再误报"未关闭"）
  - Escape 兜底按键补 `windowsVirtualKeyCode: 27`（此前合成事件 keyCode 为 0，legacy 键盘监听收不到）
  - 打招呼/打开卡片两个点击表达式去重为共享 builder，消除 DOM 变更时的双份维护漂移
  - runtime：relocate 的工具图像只保留最近 2 条消息的图，更早的替换为占位文本，长会话不再每轮重发全部历史图（用户自发的图像消息不受影响）

- Updated dependencies [[`38bb3c6`](https://github.com/steveoon/roll-agent/commit/38bb3c66dcd9090cf929b1eb6f85082839a2218f)]:
  - @roll-agent/protocol@0.5.0

## 0.14.1

### Patch Changes

- Updated dependencies [[`da6bf86`](https://github.com/steveoon/roll-agent/commit/da6bf862b208ca4bf04a0d8e4c274bfe51b3b37c)]:
  - @roll-agent/protocol@0.4.1

## 0.14.0

### Minor Changes

- [#201](https://github.com/steveoon/roll-agent/pull/201) [`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d) Thanks [@steveoon](https://github.com/steveoon)! - Add Runtime Protocol 1.3 durable event cursors, bounded per-Thread replay storage, a
  replay-to-live response barrier, and a Node client recovery manager with Snapshot fallback.

- [#196](https://github.com/steveoon/roll-agent/pull/196) [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733) Thanks [@steveoon](https://github.com/steveoon)! - Negotiate Runtime Protocol 1.2 Server Request capabilities before delivery, carry branded
  Interaction metadata on Approval requests, cancel 1.2 requests by InteractionId, and keep the
  Protocol 1.1 and 1.0 control paths wire-compatible.
  Freeze Relay Wire 1.0 against Runtime 1.2 schema drift and project newer Runtime snapshots and
  events to its existing Runtime 1.1-compatible envelope before remote delivery.

- [#197](https://github.com/steveoon/roll-agent/pull/197) [`e17ca19`](https://github.com/steveoon/roll-agent/commit/e17ca19259e5b8a263aa99bfa0979e475ab3c00d) Thanks [@steveoon](https://github.com/steveoon)! - Add the Runtime Protocol 1.2 `userInput.request` interaction, including five bounded control
  types, request-correlated result validation, safe pending projections, and a typed Node client
  handler. Expose the built-in `roll__user_input` Tool only after capability acknowledgement, wait
  in `waiting-for-user`, and settle cancellation, timeout, disconnect, or late responses exactly once.

### Patch Changes

- [#203](https://github.com/steveoon/roll-agent/pull/203) [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a) Thanks [@steveoon](https://github.com/steveoon)! - Commit Protocol 1.2+ capability acknowledgements behind the JSON-RPC response barrier so an
  Interaction created inside the ACK window can no longer reach the client before the ACK frame
  and die with -32601. Withdrawal cancellations stay synchronous while acknowledgement and
  delivery run after the response is written, which also closes the same race on revision upgrades,
  without changing the existing public coordinator setter. Approvals additionally gain the same
  absolute deadline fallback as user input (`min(now + 5 minutes, remaining turn lifetime)`) so
  embedding without `turnTimeoutMs` no longer causes every Protocol 1.2 approval to fail closed, and user input
  results are normalized against an immutable copy of the original form at both the RuntimeService
  boundary and inside the engine before reaching the model.
- Updated dependencies [[`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d), [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a), [`e17ca19`](https://github.com/steveoon/roll-agent/commit/e17ca19259e5b8a263aa99bfa0979e475ab3c00d), [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733)]:
  - @roll-agent/protocol@0.4.0

## 0.13.0

### Minor Changes

- [#192](https://github.com/steveoon/roll-agent/pull/192) [`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd) Thanks [@steveoon](https://github.com/steveoon)! - Show concise model-generated explanations in Shell approval prompts and expose them to Runtime
  Protocol GUI clients through the backward-compatible approval preview.

  Keep conservative Shell confirmation behavior while hiding misleading destructive labels for
  commands that were not actually classified as dangerous.

### Patch Changes

- Updated dependencies [[`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd)]:
  - @roll-agent/protocol@0.3.0

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
