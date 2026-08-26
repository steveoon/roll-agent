# roll 定时任务（Scheduled Tasks）v1 设计

调研报告：https://claude.ai/code/artifact/91477e7c-7f84-4104-8cb3-e280f8ac82e3（codex automations + grok-build scheduler 的点金之笔与反模式）。架构评审：Claude + kai（codex）三方一致。

## 背景与目标

roll 目前没有「让 agent 按时醒来干活」的能力。用户只能用 crontab 拉起 `roll chat --json --session <id> "…"`，拿不到：来源标记（模型不知道这是无人值守触发）、持久去重（睡眠唤醒 / 双 daemon 会重复触发）、失败可见性（`roll schedule list` 里看不到上次为什么挂）、以及无人值守时的审批语义（`ApprovalGate` 没有过期计时，卡住会烧完整个 `turnTimeoutMs`）。

v1 目标：用户能用 `roll schedule add --name … --every 30m --prompt "…"` 登记一个重复任务；`roll schedule daemon` 常驻进程按时把它变成一轮无人值守的 chat turn（新 thread、后台 host mode、审批一律拒绝、来源标记只进推理副本不进历史）；每次触发都有持久的 invocation 账本可查；异常有重试预算，耗尽后任务自动 PAUSE 并把原因显示出来。

## 已确认的决策

| 决策 | 结论 |
|---|---|
| 放哪 | core 内独立模块，不做 MCP 子 agent。调度不是业务工具，是「何时运行」的运行时属性，与 approval / thread store 同层（web-search RFC §2.1 排斥的是业务工具进 Core） |
| 分层 | `packages/runtime/src/scheduler/`（trigger、ScheduleStore、claim/lease、状态机；只依赖 zod + node:sqlite）；`packages/core/src/runtime-host/`（从 chat.ts 抽出的 Engine factory + `runJsonTurn`，不懂 Ink）；`packages/core/src/scheduler-host/`（daemon 循环、exec 子进程、OS service）。暂不新建 `packages/scheduler` |
| 常驻宿主 | **sibling daemon**（`dev.roll-agent.scheduler`），不塞进 CompanionApplication——它未 enrollment / disabled / 无 relay 就干净退出且只绑一个 cwd（`companion-host/application.ts:213-245`、`schema.ts:13-23`）。只复用 `service.ts` 的 LaunchAgent / schtasks 控制器形状 |
| 执行隔离 | daemon 不在进程内跑 turn。每次触发 **spawn 子进程** `roll schedule exec --invocation <id>`，`cwd = schedule.cwd`，于是引擎现有的 `process.cwd()` 绑定（`conversation-engine.ts:345, 576, 978`）天然正确，引擎无需 `workspaceRoot` 重构；一次 run 崩溃不影响 daemon；lease 只覆盖「spawn + 提交」 |
| 触发表达 v1 | 仅 `interval`：`"30m" / "2h" / "1d" / "90s"`，下限 60 秒，**低于下限报错不 clamp**（grok 静默抬到 60s 是反模式）。日历触发（`daily`，含 IANA `timeZone`）留 v2；`TriggerSpec` 已是 `kind` 判别联合，加种类不需要迁移 |
| 不补课 | `next_run_at` 在 **claim 时** 从 `now + everyMs` 重算；错过多少次只补一次 |
| 相位 | `--now` 创建即触发（`next_run_at = now`）；pause/resume 不改相位；v1 没有 edit 命令（v2 改 trigger 时 `next_run_at = now + everyMs`） |
| 一次性任务 | 不属于调度器（两家共识）。`roll schedule run-now <id>` 是「手动触发一次已有任务」，不是延时任务 |
| 每次触发的线程 | **新 thread**，标题 `[定时] <name>`；不复用交互线程；有界上下文链（grok 每 10 轮重开）留 v2 |
| 无人值守审批 | 双保险：① `UnattendedToolPolicy` 包装 `ConfigurableToolPolicy`，把 `confirm` 在**调用前**转成 `deny` 并记录；② exec 循环仍像 `runJsonTurn` 一样对 `confirmation-required` 事件立即 `session.reject()`（覆盖绕过 policy 的 `gateExternalPath`）。任一发生 → run 状态 `needs_confirmation`，调度照常推进 |
| 来源标记 | 走现有 `resolveDynamicCapabilityContext` 钩子：`CapabilityExternalDynamicContext.origin = { kind: "scheduled", scheduleId, invocationId, scheduledFor, unattended: true }` → `[Harness runtime context]` 多四行 `turnOrigin/scheduleId/invocationId/scheduledFor`。只贴在推理副本（`prependLastUserContext`），**不进 `this.messages`**。`CAPABILITY_TURN_CONTEXT_VERSION` 1→2 |
| host mode | 新增 `CAPABILITY_HOST_MODES.background`。system prompt 追加「无人值守运行」段；超时文案与 one-shot 同款（任务随进程结束）；后台不构建 `agent-install` 工具、不启用 `user-input` |
| 派发协议 | invocation 行持有 `claimed_by / ownership_token / lease_until`，claim 后每次写都 `WHERE ownership_token = ?`；lease 120 s，daemon 每 30 s 续租；lease 过期的 claimed/running 行被下一轮 tick **重新 claim 为同一次触发**（attempt+1），不是再发一次 |
| 失败处理 | exec 抛错 / 子进程非零退出 → `retry`，10 s 退避；`attempt > 3` → `failed` 终态，且 **scheduled 模式** 把 schedule 置 `paused` + `last_error`；manual 模式的失败永不暂停计划。`last_error` 是 `roll schedule list/show` 的一等字段（codex 不暴露是反模式） |
| 去重 | `invocations(schedule_id, mode, scheduled_for)` UNIQUE；同一 schedule 存在 live invocation（pending/claimed/running/retry）时不再产生新的 scheduled invocation |
| 配额 | `scheduler.max-schedules`（默认 50）、`scheduler.max-concurrent-runs`（默认 2）；name ≤ 120、prompt ≤ 4000 字符；输出摘录 ≤ 4000 字符。数值集中在 `SCHEDULER_LIMITS` 单一来源 |
| 存储 | `~/.roll-agent/scheduler/schedules.db`（配置 `scheduler.data-dir`），`node:sqlite`，0700/0600，`PRAGMA user_version`，`BEGIN IMMEDIATE`，时间列一律 epoch ms |
| 单例 | daemon 用 `acquireAgentLifecycleLock(schedulerDataDir, " roll-scheduler-daemon")`（NUL 前缀保留名，与 `agent-registry-lock.ts` 同法）；`daemon.json` 记 `{pid, processStartToken, startedAt, workerId}`，`roll schedule status` 用 `verifyProcessStartToken` 核实，`unavailable` 不当作死 |
| 模型可调用工具 / `/loop` | v2。v1 只有 CLI 管理面 |
| 通知 | v1 无主动通知；状态经 `roll schedule list/runs` 与 daemon 日志（stderr → `scheduler.log`）查看 |

## 架构

```
roll schedule add/list/show/remove/pause/resume/run-now/runs/status   ──┐
                                                                         ├──> ScheduleStore (runtime/scheduler, schedules.db)
roll schedule daemon --foreground  ── tick: claimDue → spawn ────────────┤            ▲
        │  (lease renew 30s, maxConcurrentRuns, bounded wake timer)       │            │ beginInvocation / completeInvocation
        └──> child: roll schedule exec --invocation <id>  (cwd=schedule.cwd)          │
                  └─ runtime-host engine factory (surface=background)                 │
                       ├─ UnattendedToolPolicy(ConfigurableToolPolicy)                │
                       ├─ resolveDynamicCapabilityContext → origin                    │
                       └─ engine.createSession → runJsonTurn ─────────────────────────┘
roll schedule service install/uninstall/status  ── LaunchAgent / schtasks（复用 companion service 控制器形状）
```

### runtime：`packages/runtime/src/scheduler/`

- `limits.ts`：`SCHEDULER_LIMITS`（minIntervalMs 60_000、claimLeaseMs 120_000、leaseRenewIntervalMs 30_000、retryBudget 3、retryBackoffMs 10_000、pollIntervalMs 15_000、maxNameChars 120、maxPromptChars 4_000、maxOutputExcerptChars 4_000）。
- `trigger.ts`：`TRIGGER_KINDS`、`triggerSpecSchema`（zod discriminated union，v1 仅 `interval { everyMs }`）、`parseIntervalText`、`createIntervalTrigger`、`formatInterval`、`describeTrigger`、`computeNextRunAtMs`、`parseTriggerJson`、`ScheduleTriggerError`。
- `types.ts`：`SCHEDULE_STATUSES`、`INVOCATION_MODES`、`INVOCATION_STATUSES`、`ScheduleRecord`、`InvocationRecord`、`ClaimedInvocation`、`CreateScheduleInput`、`CompleteInvocationInput`、`INVOCATION_FAILURE_OUTCOMES`、`ScheduleStoreError`。
- `schedule-store.ts`：`ScheduleStore`。

`schedules` 表：`id, name, prompt, cwd, trigger_json, status ∈ {active,paused}, next_run_at, last_run_at, last_error, created_at, updated_at`。
`invocations` 表：`id, schedule_id (FK CASCADE), mode ∈ {scheduled,manual}, status ∈ {pending,claimed,running,retry,completed,needs_confirmation,failed}, scheduled_for, attempt, claimed_by, ownership_token, lease_until, retry_at, thread_id, output_excerpt, error, pending_actions_json, created_at, started_at, finished_at, UNIQUE(schedule_id, mode, scheduled_for)`。

`claimDue({ workerId, nowMs, limit })` 在一个 `BEGIN IMMEDIATE` 内按序做四支：
1. `pending`（manual）→ claim，attempt = 1；
2. `retry` 且 `retry_at <= now` → 重新 claim，attempt + 1；
3. `claimed|running` 且 `lease_until <= now`（孤儿）→ 重新 claim，attempt + 1；
4. `active` 且 `next_run_at <= now` 且无 live invocation 的 schedule → INSERT scheduled invocation（`scheduled_for = next_run_at`）并 `next_run_at = now + everyMs`。
2/3 中 `attempt > retryBudget` 的行直接终态 `failed`（scheduled 模式同时 pause schedule），不返回给调用方。每支都受 `limit` 约束。

其余方法：`createSchedule`（超过 maxSchedules 抛 `schedule_limit_reached`）、`getSchedule`、`listSchedules`、`setScheduleStatus`、`removeSchedule`、`enqueueManualInvocation`、`claimPendingInvocation(id)`（run-now --inline 用）、`beginInvocation(id, token, now)`（claimed→running）、`renewLease`、`completeInvocation`、`failInvocation` → `retry-scheduled | terminal | terminal-paused | lost-claim`、`getInvocation`、`listInvocations(scheduleId, limit)`、`nextWakeAtMs(now)`、`close`。

### runtime：引擎改动（四处，均小）

1. `capability-manifest.ts`：`CAPABILITY_HOST_MODES.background`；`isProcessBoundHostMode(mode)`（one-shot | background）；`CapabilityTurnOrigin` + `origin?` 贯穿 `CapabilityExternalDynamicContext / BuildCapabilityTurnContextInput / CapabilityDynamicTurnSnapshot / sanitizeCapabilityTurnContext`；`CAPABILITY_TURN_CONTEXT_VERSION = 2`。
2. `system-prompt.ts`：`buildCapabilityTurnReminder` 追加 origin 四行；`BuildChatSystemPromptOptions.hostMode`，background 时追加 `# 无人值守运行` 段；shell 段的 one-shot 分支改用 `isProcessBoundHostMode`。
3. `agent-session.ts`：两处 `hostMode === oneShot` 改 `isProcessBoundHostMode`；`runTurn` 把 `externalDynamicContext.origin` 传给 `buildEffectiveCapabilityTurnContext`。
4. `conversation-engine.ts`：`buildSession` 的钩子包装透传 `origin`；`background` 不构建 agentInstall（`shouldOfferAgentInstall(hostMode)`）。
5. `policy/unattended-policy.ts`：`UnattendedToolPolicy`。

### core：`runtime-host/`

从 `cli/commands/chat.ts` **搬出**（chat.ts 改为 import + re-export，既有调用方零改动）：`engine-factory.ts`（`CHAT_ENGINE_SURFACES` + 新增 `background`、`chatHostModeForSurface`、`createToolPolicy`、`createChatEngine`（`CreateChatEngineInput` 新增可选 `policy`、`resolveDynamicCapabilityContext`）、`resolveChatLlmReadiness`、`resolveChatLlmCalls`、`loadRuntime`）与 `json-turn.ts`（`runJsonTurn`）。

### core：`scheduler-host/`

- `paths.ts`：`SCHEDULER_SERVICE_LABEL = "dev.roll-agent.scheduler"`、`WINDOWS_SCHEDULER_TASK_NAME`、`createSchedulerPaths(dataDir, homeDir?)` → `{ dataDir, logPath, daemonRecordPath, launchAgentPath }`。
- `execute-invocation.ts`：`executeInvocation({ store, invocationId, ownershipToken, runTurn, now? })`——beginInvocation → runTurn → completeInvocation / failInvocation；`runTurn` 可注入，测试不需要 LLM。
- `run-scheduled-turn.ts`：真实 runner——engine factory（surface `background`，`UnattendedToolPolicy`，origin 钩子）→ `createSession({ title })` → `runJsonTurn` → 合并 `policy.deniedConfirmations` 得到 `ScheduledTurnOutcome`。
- `spawn-invocation.ts`：用 `createBundledRollInvocation()` 的 `command / cliEntrypoint / execArgv` 拼 `schedule exec --invocation <id>`，`cwd = schedule.cwd`，token 经环境变量 `ROLL_SCHEDULE_OWNERSHIP_TOKEN`，stderr 追加到 `scheduler.log`。
- `daemon.ts`：`SchedulerDaemon`（可注入 `spawnInvocation / now / logger`）：tick → `claimDue(limit = maxConcurrentRuns - running)` → spawn；子进程退出后若 invocation 仍持有本 token → `failInvocation("exec 进程退出 code=…")`；每 30 s `renewLease`；`min(nextWakeAtMs, now + pollIntervalMs)` 有界定时器；abort 时 SIGTERM 子进程。
- `daemon-record.ts`：`writeDaemonRecord / readDaemonRecord / inspectDaemon`（pid + processStartToken 校验）。

### core：CLI `roll schedule …`

`schedule.ts`（组，懒加载）+ `schedule-add / list / show / remove / pause / resume / run-now / runs / status / daemon / exec / service(-install|-uninstall|-status)`。数据走 stdout（`--json`），日志走 stderr。`exec` 是 daemon 的内部入口，描述里注明。

### 配置

```yaml
scheduler:
  data-dir: ~/.roll-agent/scheduler   # 默认
  max-schedules: 50
  max-concurrent-runs: 2
```
`loader.ts` 的 `expandPaths` 必须显式展开 `scheduler.dataDir`。

## 错误处理与边界

- 间隔 < 60 s、name/prompt 超长、cwd 非绝对路径或不存在 → `roll schedule add` 退出码 1，错误说明限制值。
- daemon 未运行时 `run-now` 只入队并 warn；`run-now --inline` 在当前进程 claim 并同步等子进程结束，打印 invocation JSON。
- exec 子进程启动时 token 不匹配 / invocation 不是 claimed → 打印 `lost-claim` 并退出 0（不算失败，说明已被别的 worker 接管）。
- daemon 拿不到 OS 进程身份（`readProcessStartToken` undefined）→ 拒绝启动（与 lifecycle lock 同策略）。
- LLM 未配置 → exec 记 `failed` + `last_error`，走重试预算 → PAUSE；daemon 本身不退出。

## 测试计划

- runtime：trigger 解析/格式化/下次触发；store 的 CRUD、配额、claim 四支、UNIQUE 去重、lease 过期重新 claim、预算耗尽 PAUSE、token 失配写入无效、`nextWakeAtMs`；`UnattendedToolPolicy`；host mode / system prompt 段 / 超时文案；turn context origin 进 reminder 与 safe snapshot。
- core：config 默认值与 tilde 展开；`executeInvocation` 三种结果；`SchedulerDaemon` 用假 spawn + `t.mock.timers`；service plan 参数化（label / plist / task name）；e2e：`roll schedule add/list/pause/remove --json`（隔离 HOME，无需 LLM）、`roll --help` 含 `schedule`。
- 手动验证（需真实 LLM 配置）：`roll schedule add --now` + `roll schedule daemon --foreground` 观察 exec 子进程、`roll schedule runs <id>` 里的 `completed` 与 thread id；`roll chat --session <threadId>` 打开该线程确认用户消息里**没有** `[Harness runtime context]`。

## 评审修订（2026-08-25，kai/codex review 后）

| 评审发现 | 修订后的决策 |
|---|---|
| Node 22.6–22.12 缺 `--experimental-sqlite` | `bin/roll.js` 对 `chat` 与 `schedule` 都自动附加该 flag；engines 保持 ≥ 22.6 |
| exec 子进程按 `schedule.cwd` 重新发现配置导致账本错位 | 账本位置成为进程身份：daemon → child 走 `ROLL_SCHEDULE_DATA_DIR`；`roll schedule daemon --data-dir/--max-concurrent-runs` 由 `service install` 固化进服务定义；child 只用 cwd 配置解析 LLM / Agent / 审批 |
| lease 过期 reclaim 会重复执行仍在运行的 turn | invocation 记录 `executor_pid` + `executor_start_token`（`beginInvocation` 写入）；`claimDue` 对 `running` 行先探活：dead → reclaim，alive/unknown → 续 lease 不动（fail-closed）。没注入探针的 Store 视为 unknown。daemon 对超过 `maxRunMs`（1 h）的子进程 SIGKILL，避免「活着但卡死」永久占位 |
| 权限在创建后漂移 | 不采用 codex 式冻结快照（用户收紧配置后旧任务仍按旧边界跑）。改为：登记时记录 `authority_digest`（`runtime.approval` + `runtime.shell` 摘要），执行前比对，**任何**漂移 → 终态失败 + 暂停；`resume` 以当前配置重新记录 |
| `run-now --inline` 失败退出码 0 且遗留 retry | invocation 增加 `max_attempts`；inline 入队为 1 次尝试，失败直接终态；非 completed/needs_confirmation 退出码 1 |
| ownership token 泄漏到 shell / stdio Agent env | `takeScheduleExecEnv` 读取后立即 `delete process.env[...]`，早于 runtime / engine 加载 |
| 运行账本无保留策略 | `pruneInvocations`：每任务保留 100 条终态记录、最长 30 天；daemon 每轮 tick 清理 |
| interval 无上界 | `maxIntervalMs = 365d`，schema 与 `parseIntervalText` 同时约束 |
| daemon stop 无限等待子进程 | SIGTERM → 10 s grace → SIGKILL → 再等 10 s，仍未退出记「退出未确认」交给探活规则 |
| 缺跨进程 E2E | 新增两条无 LLM 的 E2E：`run-now --inline` 跨 cwd 配置写回登记账本并退出 1；daemon → spawn exec → 账本落 `retry` → SIGTERM 干净退出 |

schema 升到 v2（`schedules.authority_digest`、`invocations.max_attempts / executor_pid / executor_start_token`），打开 v1 库时就地补列，并把超过 365 天的旧 interval 钳位到上限且暂停。

第二轮（对抗性验证后补修）：

- `scheduler.data-dir` 相对路径以配置文件所在目录为基准解析（`loader.ts` `resolveSchedulerDataDir`），`createSchedulerPaths` 一律 `resolve()`；`roll schedule status` 打印实际 data-dir
- `--cwd` 登记时 `realpathSync`，避免 symlink 让 add 与 exec 读到不同配置从而永远「权限漂移」；digest 的 overrides 排序改为 code unit，不依赖 locale
- daemon：tick 先续租再 claim，并把自己持有的 invocation id 作为 `heldInvocationIds` 传给 `claimDue`，杜绝休眠/时钟跳变后重复拉起；`claimDue` 的续租预扫描不受 `limit` 约束，`sleepUntilWake` 在「无进展且目标已过期」时退避一个 poll 间隔，消除 busy loop；孤儿 exec 进程（上一个 daemon 留下、运行超过 `maxRunMs`）由 `terminateExecutor` 校验身份后 SIGKILL；停止后才退出的子进程不再触碰已关闭的账本；二次 SIGTERM 只记日志不打断 grace；非 TTY 下只写文件日志
- `pause` 立即放弃 scheduled 模式的 retry 行；暂停任务的过期 claim 终态化而不重跑；trigger 无法解析的行只暂停自己
- `bin/roll`：内层进程被信号杀死时透传信号 / 退出码 1；进入子进程前清掉 `ROLL_SQLITE_RESPAWNED`，嵌套 `roll schedule …` 仍能自行加 flag；`service install` 先探测 `node:sqlite` 可加载；`--max-concurrent-runs` 复用 schema 上界 1..8
- 不改并记录：同 uid 可经 `ps -E` 看到 token（同 uid 本就能读 0600 的账本）；探活在 `BEGIN IMMEDIATE` 内执行（仅 lease 过期行）；macOS 启动身份秒级粒度；Windows `schtasks /TR` 261 字符上限需 Windows 主机实测

第三轮（kai 二审，High · confirmed：manual run-now 绕过同 schedule 单例约束）：

- 单例门禁进账本事务：`claimPendingInvocation` 的 UPDATE 带 `NOT EXISTS 其他 claimed/running`；`claimDue` 对 pending / retry / 过期行同样检查 `hasOtherLiveRunInTransaction`。manual 触发在运行中排队，`run-now --inline` 被挡时删掉刚入队的行并退出 1；不提供 `--force`
- 人工出口：`roll schedule cancel <invocation-id>`。kai 三审指出首版对 running 行 fail-open（先置终态再可选 kill）。改为：pending / retry / 未 begin 的 claimed 直接取消；running 行由 `cancelInvocation` 在事务内探活，alive → `executor-alive`（CLI 要求 `--kill`，kill 后轮询确认 dead 再取消），unknown → `executor-unknown`（只能显式 `--abandon`，命名与文案标明危险），dead → 取消。单例只在确认退出或显式放弃时释放
- exec 以进程组运行（POSIX `detached` + `kill(-pid)`），`maxRunMs` / 孤儿终止覆盖后代进程；文档改口：保证「不会同时运行两个可验证存活的 exec 进程」，不承诺 exactly-once
- kai 四审（High：PATH shadow）：僵尸判定曾调用 PATH 上的裸 `ps`，伪造输出 `Z` 的 `ps` 可让存活 executor 被判 dead 而释放单例。改为只信任 `/bin/ps` / `/usr/bin/ps` 绝对路径（找不到 → 状态未知 → 维持 alive，fail-closed），并加 PATH-shadow 回归；Windows 终止改用 `%SystemRoot%\\System32\\taskkill.exe /T /F`（复用 bash profile 先例，未在 Windows 主机实测）；`--kill` 与 `--abandon` 参数层互斥
- kai 五审（Medium · PLAUSIBLE：Windows `taskkill` 失败后退回只杀根进程却报告树终止成功）：`killProcessTree` 改为返回 `tree-terminated | root-only | failed` 判别联合，helper 内不再退回根 PID（POSIX 进程组信号失败同样返回 failed）；`terminateExecutor` 同样返回联合；`cancel --kill` 在树终止失败时拒绝取消、不释放单例，executor 不可验证时仍走 `--abandon` 路径；daemon/spawner 的 best-effort 根进程终止由调用方执行并记日志「未整体终止」；Windows SIGTERM 阶段用不带 `/F` 的 `taskkill /T`。可注入 platform / spawnSync / kill 的失败分支单测覆盖 taskkill 非零、启动失败、缺 SystemRoot、POSIX 非组首领
- kai 六审（两条 High：根进程退出 ≠ 进程树退出）：`cancel --kill` 在树终止失败但根已死时仍判 confirmed；daemon 在根进程退出时直接 `failInvocation`，同组后代可能仍活着而单例被释放。修法把探活升级为进程组级：根死（含僵尸）后用可信 `ps -A -o pid=,pgid=,stat=` 数同组非僵尸成员，有成员 → 新状态 `descendants-alive`（store 视同存活：不 reclaim、`cancel` 返回 executor-alive、`terminateExecutor` 可整组终止）；daemon `onExit` 先探进程组，有后代存活就保留 `running` 并交给探活 / `maxRunMs`；CLI 只在探活 dead（POSIX = 组已空）时 confirmed，Windows 无法验证后代 → `--abandon`。daemon 自己发出的树终止若未被确认（kill 返回非 tree-terminated），子进程退出后同样保留 running 不重试，不依赖探针；spawner 去掉 root-only 退化（进程组信号失败时根进程也无法/无需单独终止）。探活单一来源：daemon 复用 Store 注入的探针（`store.probeExecutor`），未注入探针的 Store 默认 unknown → daemon 亦 fail-closed。真实进程组测试覆盖：根退出 + 后代存活 → descendants-alive → 整组终止 → dead；kai 的三个六审探针重跑均为保持 running / 后代已清理
- 第七轮（Windows 兼容评估，静态；报告 https://claude.ai/code/artifact/9447eabf-e41f-482b-82be-1ac6d1cda5fe ）：`schtasks /TR` 261 字符上限在 pnpm 全局 / Node 22.6–22.12 路径下必然超限（272 / 298），且 CLI 注册的任务默认 72 小时运行上限、无失败重启、电池供电不启动。改为 `schtasks /Create /XML` 注册：`install` 先用 `whoami` 取当前用户 SID 写入 Principal / LogonTrigger，`ExecutionTimeLimit PT0S`、`RestartOnFailure PT1M×3`、电池设置关闭，XML 以 UTF-16LE+BOM 写到 data-dir。进程身份：Windows 只信任 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` / `%ProgramFiles%\PowerShell\7\pwsh.exe`，超时 8 s，exec 读身份失败先重试一次再 terminal。daemon：`treeKillUnconfirmed` 采用最近一次 kill 结果（后续 `/T /F` 成功即清除）；win32 不再发无意义的 `taskkill /T`（无 `/F`）阶段，grace 后直接强制终止；exec 在 win32 也 `detached`；daemon 监听 SIGHUP / SIGBREAK。`cancel --kill` 在 Windows 根已退出时取消并告警「后代不可验证」。`run-now --inline` 退出后同样先看最近一次 kill 结果与执行者探活（`decideInlineExit`），树终止未确认或后代存活 / 无法探活时保留 `running`，不再无条件 `failInvocation`；inline 也监听 SIGHUP / SIGBREAK；`SpawnedInvocation.kill` 的 signal 改为必填。未改：`schtasks /End` 强杀语义（文档说明）；登录黑窗（待真机评估 S4U）；全部 Windows 行为仅有注入式单测与 PR 触发的 windows-latest job 覆盖，无真机验证
- 待拍板（产品取舍，未改）：authority digest 只覆盖 `runtime.approval` / `runtime.shell`，不覆盖 Agent / tool metadata；scheduled run 创建的 Thread 不随账本清理

## 不覆盖（v2）

日历触发 + 时区、`/loop` 与模型可调用 `roll__schedule` 工具、有界上下文链复用线程、主动通知、`roll doctor` 检查项、Linux systemd 用户服务。
