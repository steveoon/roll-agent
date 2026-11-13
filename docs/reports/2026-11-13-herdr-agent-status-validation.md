# Herdr Agent Status：实现与验证记录

日期：2026-11-13。执行：Roll t1；待独立复核：Codex t3。

## 交付结论

交互式 `roll chat` 的 OSC 7501 集成及综合 Review follow-up 任务 1–4 已实现，覆盖 Ink 和基础 REPL。**修复后定向回归 202/202 通过（0 skipped），真实 Herdr 超时、用户取消及同回合未查看/已查看提醒转换通过；完整 Core 测试仍有一项已在 HEAD 基线复现的调度帮助失败。** 独立复核入口见 [Codex/t4 综合报告](2026-11-13-herdr-agent-status-review.md)；本报告是执行者验收，不等同于 t3 已签收。

下方“首轮”保留修复前验证历史，**最终状态、环境、图检查及限制以末尾的“综合复核修复与最终验收”节为准**，不将先前假阳性写成从未失败。长期证据附在 `assets/`，不依赖临时路径才能理解结论。

- 分支 `dev`，HEAD `3ee2ea3da2a87a8738e82a7c559267c4439b2738`。
- 首次实现开始时工作区干净；本轮 follow-up 接手时为 dirty，原有改动全部保留。最终仍为 dirty，未暂存、commit、push、发布或全局安装。
- Node `v24.22.3`，pnpm `11.24.0`。未修改依赖、lockfile、package version 或用户认证。
- 没有启动实现 Agent、另建 worktree、重启 Herdr Core 或中断用户 t1/t3。
- 尚在运行的 t1 是原全局 Roll，不会热加载此次源码，所以它仍可能 `reported=false`；这不代表新源码验收失败。

## 实现边界

### 上报器

`packages/core/src/cli/chat/terminal-agent-status.ts`：

- 固定根身份 `app=roll`，精确 OSC 7501 / ST 编码；`clear` 不附 app。
- 启用条件为交互入口、非空 `HC_TERMINAL_ID` 和 stdin/stdout/stderr 全部 TTY。没有 HERDR_ENV、品牌猜测、stdin 探测器或新增公开配置。
- 在 Ink 接管前捕获 stderr 的文件描述符；使用 `writeSync` 独立控制写入，处理短写，绕过日志、console、Ink 和 ManagedChatOutput。同步写入错误会永久停用本实例上报，不传播到聊天，也不注册全局异常处理器。
- 同状态与 kind 去重；代次/回合句柄使 finish、reset、新回合或 dispose 后的旧回调无效；dispose 幂等。
- 结果类型、等待类型从 `as const` 派生；终态映射固定 completed→done、cancelled→idle、failed→error。
- 两种前端共用 `terminalAgentOutcomeAfterEvent`：终止 error 记录 failed，turn-cancelled 仅 reason=user 记录 cancelled，reason=timeout/runtime 记录 failed，已有 failed 不被后续取消覆盖；不根据 message-finish 或 UI phase 判断完成。首轮曾不区分取消原因，已由本轮修复。

### 生命周期接线

- `commands/chat.ts` 交互分支持有唯一 owner，最外层 finally dispose，覆盖 Ink、基础 REPL、Ink 启动失败 fallback。
- Ink 经 `run-ink-repl.ts` / `app.ts` 传入 `useSession`。ready 在 ChatSessionView 挂载 effect 中触发，而非 render() 刚返回时提前声明已可输入。
- submit 在 beforeSend 前 working，手动 compact 也创建回合；审批自动批准分支不 blocked；表单过期不 blocked。实际等待解除后 working。
- 异步迭代器（包括尾部持久化）真正结束后才 finish；取消请求本身不立即 idle；done/error 不随 UI turn-end→idle 被覆盖。
- 成功切换会话显式 reset；失败保持原终态；hook 卸载不 clear。
- 基础 REPL 包装已有 confirm/userInputPrompt，保留 clack 选择式审批、输入恢复和 fullDiff 透传，没有把 ChatRenderer 变成全局上报器。
- Runtime、Protocol、Herdr 客户端源码均未修改。

### 文档与版本

- `docs/how-to-use-herdr.md`，README 短链接。
- `.changeset/roll-herdr-agent-status.md`：仅 `@roll-agent/core: minor`，理由为向后兼容的用户可见新增集成。
- `pnpm exec changeset status` 通过：Core minor；同时列出的 Runtime patch 来自基线已有的 `snapshot-step-message-timestamps.md`，不是本次修改。
- `changeset status --since HEAD` 不包含未跟踪的新 changeset，曾报 no changesets；未为满足检查而暂存共享工作区。

## 首轮自动验证（修复前历史）

| 检查 | 真实结果 |
| --- | --- |
| Core typecheck 基线 | 通过 |
| reporter 首次测试 | 预期红灯：实现文件尚不存在，ERR_MODULE_NOT_FOUND |
| 最终 `pnpm --filter @roll-agent/core typecheck` | 通过，包含 CLI 和 UI 类型检查 |
| 最终聊天相关回归集 | **171/171 通过，0 skipped**，使用 `NODE_ENV=test` |
| 真实 Unix PTY | Ink、基础 REPL 各一项通过；两者均实际运行当前源码，没有 printf 假报 |
| 全仓库 `pnpm lint` | 最终通过；逐文件 verify_file 也通过 |
| 本次变更文件 Prettier | 通过 |
| 全仓库 `pnpm format:check` | 未通过：46 个未由本次修改的已有/忽略文件，包括 .gitnexus 产物、browser-use 文件和 pnpm-lock.yaml；没有批量改无关文件 |
| 控制字符 guard | 通过 |
| `git diff --check` | 通过 |
| Core build | 通过：tsc、327 个 JS 混淆、Vite UI build |
| 构建产物 `agent health` | CLI 入口成功执行，但退出 1：已有 browser-use sidecar 为 Core 2.0.2，本地源码 Core 2.0.1；其他四个按需 Agent 正常。未重启或升级 sidecar |
| 完整 Core test（继承 production 环境） | 2263 项：2249 pass / 5 fail / 9 skipped。5 个失败为未修改 viewport 测试的 React act 不可用 |
| 完整 Core test（NODE_ENV=test） | 2263 项：2253 pass / 1 fail / 9 skipped。viewport 已通过；剩余调度帮助输出断言失败 |
| 完整 Core test（test 环境、并发 4） | 2265 项：2255 pass / 1 fail / 9 skipped。新增入口测试通过；同一个调度帮助输出断言仍失败 |

完整测试的剩余失败是 `src/cli/commands/schedule-calendar.test.ts:105`：预期 help.stdout 包含 `--start-at`，实际空字符串。该测试与调度实现不在本次 diff 中；t3 后续已在 git archive HEAD 的独立快照复现同一失败。本轮仍不把完整测试写成通过，也不扩大到调度修复。

production 环境的 5 项 act 失败已核对：`NODE_ENV=production`，实际 `typeof react.act === "undefined"`，viewport 测试文件与 HEAD 的 SHA-256 都是 `9fe8e40552cbe2362523f09cbde612a64e5df940dda7a6592b48f93537540cd5`。

最终 171 项命令覆盖：

```sh
pnpm --filter @roll-agent/core typecheck
NODE_ENV=test node --experimental-strip-types --experimental-sqlite --test \
  packages/core/src/cli/chat/terminal-agent-status.test.ts \
  packages/core/src/cli/chat/ink/use-session-status.test.ts \
  packages/core/src/cli/chat/ink/use-session-recovery.test.ts \
  packages/core/src/cli/chat/ink/app.test.ts \
  packages/core/src/cli/chat/ink/terminal-output.test.ts \
  packages/core/src/cli/chat/ink/chatgpt-connection.test.ts \
  packages/core/src/cli/chat/ink/terminal-agent-status.pty.test.ts \
  packages/core/src/cli/commands/chat-status.test.ts \
  packages/core/src/cli/commands/chat-status-entry.test.ts \
  packages/core/src/cli/commands/chat.test.ts
```

关键用例：permission 拒绝后继续、自动批准无 blocked、question 取消/超时及已过期、message-finish 后尾部失败为 error、取消清理前保持 working、准备阶段失败与取消区分、模型重试恢复 done、compact 无 message-finish 仍完成、会话切换成功/失败、旧尾部与 clear 后不复活、退出 owner 唯一、缩放不丢状态。

命令入口用子进程验证 stdout/stderr 两流：无 HC、每个 TTY false、单次、JSON（含缺消息拒绝）、chat server、runtime stdio 均无 OSC；另覆盖启用基本模式和 Ink 启动失败 fallback。11 项全部通过。

## 首轮真实 Herdr 验收（与单测独立）

使用用户已运行的 Herdr Core，但仅创建本任务专用终端：

- `t5` / `roll-status-ink`，PID 96439。
- `t6` / `roll-status-basic`，PID 96441。
- 两者运行离线 fixture，经过实际 runInkRepl/runRepl/useSession 和生产 reporter；fixture 只生成 SessionEvent 和等待门控，不直接发 OSC。
- 门控目录：`/tmp/roll-herdr-status-ink.s7AIez`、`/tmp/roll-herdr-status-basic.qp1F4R`。
- 驱动最终路径：`packages/core/src/cli/chat/ink/fixtures/terminal-agent-status.e2e-harness.ts`（验收后按现有 build exclude 约定改名；实际运行时为同内容的 terminal-agent-status.ts）。

以下均通过真实 `hc get --json` 返回核对，两种前端一致：

| 时点 | t5 与 t6 的根事实 |
| --- | --- |
| 初始 ready | `reported:true`, `status:{app:"roll",state:"idle"}`, turn 0 |
| success 等待门控 | `working`, turn 0 |
| success 收尾后 | `done`, turn 1 |
| permission 等待 | `blocked`, `kind:"permission"`, turn 2 |
| 查看 fixture.noop 后选择默认 No | `working`, turn 2 |
| permission 后收尾 | done；下一次 send 返回此前 done / turn 3 |
| question 等待 | `blocked`, `kind:"question"`, turn 4 |
| 输入 yes 并确认提交 | `working`, turn 4 |
| question 后收尾 | done；下一次 send 返回此前 done / turn 5 |
| 受控 failure | `error`, turn 6 |
| 取消事件且门控收尾后 | `idle`, turn 7 |
| 正常退出 | exit_code 0，state finished，status null；reported 仍 true |

Ink 表单还有单独的“确认提交”页，验收实际确认后才观察到 working。没有使用 force 绕过 blocked；审批检查后按 No，不执行实际业务工具。

### 客户端可视验收

另建 `t7 / roll-status-sidebar`，通过 terminal.keep 临时加入独立标签页；恢复 t1 原标签页和面板焦点后截图。

- `herdr-app ls` 实际返回该终端 `app:"roll"`, `status:"idle"`。
- `/tmp/roll-herdr-status-sidebar.png` 已用图像能力查看：左侧 Agents / Idle 列表出现机器人图标的 `nano-agent · roll-status...`，不是仅看到终端标题。
- t7 正常退出 0、status null，然后 hc rm 清理 t5/t6/t7。最终 herdr-app ls 只剩原 t1/t3/t4，原标签页/焦点已恢复，errors 为空。
- **首轮未验证**客户端未查看 done 的提醒、已查看后 idle 的完整视觉转换/排序；本轮已补齐，见末尾同一 t12/turn 1 的前后事实与归档截图。
- 原 t1/t3 没有发送按键、取消或退出；最终仅按用户授权向 t3 发送交付通知。

## 首轮 GitNexus 与风险（历史）

- 实施前：useSession、runRepl upstream LOW；ChatApp/ChatSessionView/runInkRepl UNKNOWN 已结合实际 React h() 与动态 import 调用补证。commands/chat.ts 文件 upstream LOW，导入方包含 runtime-serve.ts。
- 实施后刷新索引：43,186 nodes / 127,280 edges / 1229 clusters / 1085 flows。
- `detect-changes --scope all --repo .` 返回 7 个 tracked files / 25 symbols / 17 affected flows，**risk critical**，已明确告知，不降级为 low。
- `--limit 200` 重试仍由 CLI 展示层省略 10 个符号及 7 条流程；索引分析也报告 callable-value-flow cap、跨语言未解析及流程预算截断。
- 该 CLI diff 检查未把未跟踪新文件计入 7 个文件；新文件已经索引、单测和类型检查覆盖，但**图检查不能作为完整 clean gate**。待 Codex 复核/后续暂存时须对完整文件集再做机器可读分析；本次不暂存、不提交。
- 重点复核 ChatSessionView 和 runInkRepl 的启动、切会话、关闭路径，以及 runRepl 的审批/表单包装，不能因 UI phase idle 或无图边就认定没有影响。

## 与计划的必要局部调整

1. ready 从 runInkRepl 的 render() 返回点移到 ChatSessionView 的 mount effect，避免输入监听尚未安装就报告 idle；runInkRepl 保留传参，不拥有 clear。
2. 独立测试文件 `commands/chat-status*.test.ts`，避免把大批状态测试混入原 chat.test.ts；原回归完整运行。
3. 离线 fixture 标为 `.e2e-harness.ts`，遵守已有生产构建排除规则。最初顶层 await 进入混淆导致构建失败，改名后生产 build 通过；没有修改混淆器或 tsconfig。
4. PTY 按观察到的英文 No、表单确认页及输入帧推进；状态事件是业务事实，不能假设 React 新输入帧已经同时提交。测试不靠随机模型或直接打印协议。
5. 全仓库旧格式、环境相关回归失败、既有 sidecar 版本冲突和图检查不完整均保留为限制，没有扩大范围修复。

## 未提交文件范围

修改：README、Ink app/app.test/run-ink-repl/use-session/use-session-recovery.test、commands/chat.ts。

新增：reporter 与测试、Ink use-session-status/PTY 测试及 e2e-harness、commands chat-status/chat-status-entry 测试、产品文档、本报告、Core minor changeset。

自审：控制报文没有动态文本；不进入 ManagedChatOutput；成功/失败/取消以迭代尾部为准；auto approval 无 blocked；reset/dispose 使旧句柄失效；清理不在 hook；未修改 Protocol/Runtime 依赖边界。以上是执行者自审，不代替 Codex 独立复核。

## 综合复核修复与最终验收

### 基线、归属与修复前后

本轮仍在同一 `dev` / HEAD `3ee2ea3da2a87a8738e82a7c559267c4439b2738` 的 dirty 工作区完成，不另开实现 Agent/worktree。macOS，Node v24.22.3、pnpm 11.24.0，Herdr Core (`hc`) 0.1.21、Herdr App 0.1.15。继承环境原为 `NODE_ENV=production`，React 测试显式设 `NODE_ENV=test`。

| 问题 | 修复前证据 | 最终行为 |
| --- | --- | --- |
| 异常中止被当作普通取消 | mapper 新测试先红：timeout 实际 cancelled、预期 failed；真实模型超时两端 idle | 完整 Record 从 `SessionEvent.reason` 派生；user→cancelled/idle，timeout/runtime→failed/error，failed 优先 |
| 审批逾期悬挂 | 两端真实 AgentSession 审批测试先红，最终状态条件超时 | Ink 幂等 settle；renderer deadline signal；到期解除等待、不执行工具、继续消费 Runtime 最终事件 |
| 旧事件兼容与边界 | HEAD 已有前端不消费 expiresAt 的交互缺口，被新 blocked 契约暴露 | optional 缺省兼容；非法/已过期（含 auto）不授权、不 blocked；迟到 Yes 拒绝；timer 分段，取消/unmount 清理当前 wait，旧句柄不污染新会话 |
| 毫秒截止期竞争 | 小窗口 PTY 首轮 basic 偶现审批拒绝后 done，而真实整轮 deadline 尚未被处理 | timer 向外取整 1ms，避免 ISO 毫秒截断导致前端抢先同期限 Runtime timer；精确边界点击仍以 Date.now 再检，绝不延后授权窗口。两端真实超时严格 error 断言保留 |
| 入口伪 TTY | 仅去掉 CI 未复现；去掉 CI/CONTINUOUS_INTEGRATION/BUILD_NUMBER/RUN_ID 后 one-shot watchdog 失败，stderr cursorTo is not a function | 子进程固定 CI=1，矩阵只验入口/门控，真实渲染由 PTY 验；不改生产 spinner |
| JSON interactive 假阳性 | 旧断言仅 exit=1，提前初始化错误也可通过 | 必须出现 `--json 模式需要消息`；one-shot 有 ok、JSON 为 completed/output=ok；server/runtime 有 stdio JSON-RPC 启动证据 |

不把“单次审批过期”强制改成整轮 error：独立审批过期但迭代继续正常结束时仍 done。真实 Runtime timeout 的 error 由后续 turn-cancelled.reason=timeout 得出。保留 `ChatConfirm(message, signal?, fullDiff?)`、clack 选择式交互和完整变更分页；question 默认超时原因与回归不变。未修改 Runtime/Protocol。

### 最终自动检查

| 检查 | 本轮结果 |
| --- | --- |
| Core CLI/UI typecheck | 通过 |
| 定向完整回归 | **202/202 pass、0 fail、0 skipped**；原 171 项文件全部包含，另加 renderer 与新用例 |
| 真实 Unix PTY | **4/4 pass**：原 Ink/basic 渲染矩阵；新增两端 8行×35列隐藏审批后真实 Runtime timeout→error、无 done、工具未执行、正常 clear/exit |
| 入口双环境 | 父环境清除上述四种 CI 标记 **11/11**；父环境 CI=1 **11/11**；继承 NODE_ENV=test |
| 全仓 pnpm lint / 受影响 TS eslint | 通过；逐文件 verify_file 同时验证 |
| 本次修改文件格式 / 控制字符 / diff 空白 | 通过；不扩大到已记录的全仓旧格式 |
| Core build / 只读发布清单 | 构建通过，327 JS + Vite UI；dist 内无 `.test.*`、`.e2e-harness.*`，公开 files 仍 dist/bin/THIRD_PARTY_NOTICES.txt |
| 构建后 agent health | 退出 1，仍为原 browser-use sidecar Core2.0.2 对源码 Core2.0.1；其余四个按需 Agent 正常。未重启/更新 |
| 完整 Core test，NODE_ENV=test，并发4 | **2285 tests：2275 pass / 1 fail / 9 skipped**。唯一失败仍是 schedule-calendar.test.ts:105 的 help.stdout 空字符串，不是本次 diff；t3 已在 HEAD 独立快照复现 |
| Changesets | 通过；本功能的 Core minor 覆盖新增集成及本轮兼容性修复。Runtime patch 来自原有 changeset，不是本轮变更 |

最终定向命令为上方首轮 10 个测试文件，另加 `packages/core/src/cli/utils/chat-renderer.test.ts` 与 `packages/core/src/cli/chat/ink/permission-deadline.pty.test.ts`，仍使用 `env NODE_ENV=test node --experimental-strip-types --experimental-sqlite --test`。完整命令为 `env NODE_ENV=test pnpm --filter @roll-agent/core test --test-concurrency=4`。类型检查和 build 命令未变。

### 真实 Herdr：受控模型、真实 Runtime 与客户端

新驱动 `ink/fixtures/herdr-review.e2e-harness.ts` 使用真实 AgentSession、DefaultToolPolicy 与生产前端/reporter，无 mock send、无直接写 OSC。离线模型不等同于真实 Provider；普通超时等待真实 abort，审批是内建 write_file 的真实安全门，写入目标始终未执行，驱动退出时复核文件不存在。

| 专用终端 | 场景 | Core 最终事实（UTC epoch ms） | 结果 |
| --- | --- | --- | --- |
| t8 / Ink | 普通模型 5秒超时 | error，turn1，status_ms=1794564675977 | 通过 |
| t9 / Ink | permission 无人响应 | blocked/permission→error，turn2，status_ms=1794564676215 | 通过 |
| t10 / basic | 普通模型 5秒超时 | error，turn1，status_ms=1794564676458 | 通过 |
| t11 / basic | permission 无人响应 | blocked/permission→error，turn2，status_ms=1794564676706 | 通过 |
| t13 / Ink | 实际 pending inference 期间 hc keys esc | idle，turn1，status_ms=1794564760359 | 通过，真实 session.cancel，不是 fixture 直接发取消事件 |
| t12 / Ink | 放开离线模型门控正常成功 | done，turn1，status_ms=1794564765739 | 通过 |
| t8–t13 | 正常 /exit 或 exit | 全部 exit_code=0、status=null、reported=true | 通过，随后仅移除这些自建终端 |

计时器边界与最终语法检查完成后，另以最终源码重跑四个隐藏终端：t14 Ink/model→error(turn1,status_ms=1794565486744)，t15 Ink/permission→error(turn2,1794565486973)，t16 basic/model→error(turn1,1794565487178)，t17 basic/permission→error(turn2,1794565487400)。均正常退出0、根状态null后移除，无客户端聚焦变化；对应事实追加到 JSON 的 `finalSourceTimeoutRepeat`。最终源码 CLI/UI typecheck 与 Core build 再次通过。

通过 `hc wait` 等待状态，不用 sleep 轮询。最初 App 尚未同步 t12 时 terminal.keep 返回 no running terminal；检查 hc get 确认真正运行后再次加入成功，未重复创建终端。收尾恢复原 tab1/t3 焦点，App errors=[]，只剩用户原 t1/t3/t4；未发测试键、未中断这些终端，未改设置或重启 Core。

#### 同一成功回合的提醒验收

两次读取均为 **t12 / turn1 / Core status_ms=1794564765739**，期间无新回合，不用 root 状态变化假冒客户端已查看语义。

| UTC 读取时点 | Core 根事实 | herdr.seen / App 投影 | 已查看图片 |
| --- | --- | --- | --- |
| 10:12:55.684997 | reported=true, app=roll, done | 0 / done；焦点 t13；Agents 的 Done 1 分组、成功 tab 与行均有蓝点 | [未查看原图](assets/herdr-2026-11-13-unseen-full.png) |
| 10:13:12.377237 | 同一 done、turn1、status_ms 不变 | 1 / idle；聚焦 t12；Done 分组消失，成功行移入 Idle，蓝点消失 | [已查看原图](assets/herdr-2026-11-13-viewed-full.png) |

两张截图均已通过图像读取检查，不是仅存文件名。选定字段、环境、对应时序和 SHA-256 归档为 [机器可读事实](assets/herdr-2026-11-13-observations.json)。完整截图保留原像素，不用临时 PID/目录作为长期结论的唯一依据。没有测试操作系统通知横幅/声音、多个客户端并发已读或任意排序算法，以上仅签收本次 Done→Idle 分组与未查看提示。

### 最终图检查、边界与交接

修改前已按契约执行 impact 并提示 CRITICAL/HIGH；mapper 的两个实际生产消费点是 Ink drive 和 REPL runTurn，scope 经 ChatRenderer.handle 使用；React h()/动态 import/对象属性及测试发现入口以源码和执行回归补证，UNKNOWN 不是低风险。

首次增量刷新后出现异常：mapper context 的 uid/filePath 为 NUL，detect_changes 虽枚举27文件却只有76符号、0流程、low。**此结果已弃用，不作 clean gate。** 随后 `node .gitnexus/run.cjs analyze --force --index-only` 全量重建，mapper 路径恢复正常、incoming calls 存在。最终重建统计 43,240 nodes / 127,462 edges / 1228 clusters / 1085 flows。

使用独立 `GIT_INDEX_FILE`、独立 `GIT_OBJECT_DIRECTORY`、真实 objects 只作 alternate：`git read-tree HEAD`，只在临时 index 对 `git ls-files --others --exclude-standard` 集合 intent-to-add；LocalBackend.detect_changes 传 repo=roll-agent、scope=all、max_symbols=5000、limit=5000。**最终图快照27文件 / 187 changed_symbols / 17 affected_processes / critical**；两数组长度逐项等于 summary，无 partial/truncated/error 标记。真实 `.git/index` SHA-256 前后均为 `95975f5da5b4a6c9e5dd1f23ed39dc56ea2067b01927a152011c46c5aee4bd60`、真实暂存区为空。临时完整原始结果本机线索：`/var/folders/s3/6g1jk25x6w540ddns5r0_yh00000gn/T/roll-herdr-followup-graph-or7tpe2o/result-final.json`。

critical 是影响面、不是漏洞评级，不降低为 low；17 流程也不与修复前 t3 的994流程等同：重建改变了解析结果。分析器仍报告 callable-value-flow cap、跨语言未解析与全局流程预算裁剪；完整 diff 响应不截断不等于静态图没有盲区。生产调用链已结合源码、202定向回归和真实Runtime/Herdr核验，不据缺边删除或改写无关代码。

全仓旧格式、调度旧失败、sidecar 版本差异和未复现的 Linux EAGAIN 不在本轮修复范围。未改 Runtime/Protocol、lockfile、依赖或全局安装；未暂存/commit/push/发布。完成后向 t3 发送报告路径和剩余限制，请求独立复核；不把发送成功视为复核通过。
