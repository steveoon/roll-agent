# Scheduler「先清场、再落终态」设计

日期：2026-08-27 · 基线：`ebf3093`（dev，codex W15 + review 修复之后）· 状态：已实现（本轮增量：持久化树所有权；review 修复见 §8 末尾）

## 1. 问题（使用者视角）

`roll schedule` 的产品承诺是：无人值守跑一轮 agent，**跑完就结束**，同一任务不叠着跑，`stop` / `cancel` 说停就停。当前实现里「跑完就结束」对一类常见任务不成立，而且失败方式是静默的——账本写 `completed`，`roll schedule runs` 显示成功，没有任何 roll 命令能看到或清掉留下的进程。

三个典型场景（机制静态可证 + 探针实测；出现频率取决于任务写了什么）：

1. **任务里起了后台进程**（`pnpm dev &`、`nohup script &`）。bash 工具每条命令 `detached` 自成 session（`packages/runtime/src/bash/profile.ts:150-155`），命令正常退出不清进程组（`packages/runtime/src/bash/exec.ts:363-392`）。下一轮 `EADDRINUSE`，一天下来几十个进程；`cancel --kill` 回答「已是终态」，`daemon stop` / `service uninstall` 把 daemon 停了、这些进程一个不少。
2. **stdio MCP 拉起的孙进程**（playwright / puppeteer 类拉 Chromium）。轮次结束 `dispose()` 走 SDK close：stdin 关闭 → 2 s → SIGTERM → 2 s → SIGKILL，不等、不管孙进程（MCP SDK `client/stdio.js:143-175`）。Chromium 成孤儿并握着 profile 锁，下一轮持续失败。
3. **残留物本身会动作**（后台循环脚本继续发消息 / commit）：这才是真正的「两轮叠着跑」，且账本上找不到任何 running 的东西。

根因：`packages/core/src/scheduler-host/execute-invocation.ts:143` 在 `runTurn` 返回后直接 `completeInvocation`，不做任何清场；终态写入即释放单例（`schedule-store.ts` `completeInvocation` 清空 `ownership_token` / `lease_until`）。daemon `onExit`（`daemon.ts:255-269`）与 `executorTreeStillAlive`（`daemon.ts:317-328`）在行已是终态时直接返回，残留物从此无主。

已被前几轮修掉、本设计不再覆盖：TOKEN_MISMATCH 误杀（W14，`executor-liveness.ts:122-129`）、inline 无条件 `failInvocation`（`inline-exit.ts`）、cancel 时 exec 自行写 failed（`interrupted` outcome）。

## 2. 目标 / 非目标

**目标**

- 一次定时运行拥有它拉起的整棵进程树；运行结束（成功、失败、被中断）时树被清掉；清不掉就不报成功。
- 让 `stop` / `cancel` / `uninstall` 的「停就是停」对 bash 后台进程与 MCP 孙进程也成立（POSIX）。
- 树所有权写入账本（schema v4：`tree_tracked_pgids` JSON 为 `{ pgid, leaderState, startToken? }[]`；内部 `trackedPgids` 数字数组读成 `unknown`，不兼容旧 `{ leaderExited }` 对象；`tree_unsettled` / `tree_survivor_pids`），`complete` / `fail`（终态）/ `cancel` / daemon `onExit` / inline 收尾 / pause / worker shutdown 共用「树已空」门禁。缺失或损坏的 ownership 元数据必须 fail-closed，不能等价为空树。
- `roll chat` 行为不变。

**非目标**

- 持久化成功 turn 的输出到影子列（仍只在 thread 里；树不清就不落账）。
- cgroup / Windows Job Object；不把 `unsupported` 改成视同已清之外的语义。
- 解析 darwin `kern.procargs2`（后续任务 #238：优先做 SDK / runtime 显式登记外部子进程，只有必须扫描任意第三方进程时再考虑）。
- 改 bash 工具的 `detached: true` 或 MCP SDK 的 close 语义。

## 3. 不变量

> 任何路径写入终态（`completed` / `needs_confirmation` / `failed`）或 `cancel`（非 `--abandon`）之前，必须能证明本 invocation 可枚举树成员数为 0。做不到就保持 `running`。`retry` 不是终态，允许带着未清树离开，但必须把登记组一起带走；**`retry` + 未清树视为同 schedule 占用态**，挡住新的 manual/scheduled claim。`pause` 只停后续触发，不清空未清树的 invocation。`remove` 拒绝 live / 未清树的 schedule，除非显式 `--abandon`。所有终态 writer（含 pause / worker shutdown）必须经过 tree gate；`--abandon` 是唯一 force 出口。

推论：单例释放 = 终态写入 ⇒ 释放前旧执行者树已死。exec 根进程在写终态后残留几毫秒不违反不变量（探活只对 `running` 行有意义）。组外 survivor 不再靠「重试耗尽后 paused」释放单例。

## 4. 树的定义（三个来源取并集）

| 来源 | 覆盖 | 枚举手段 | 平台 |
|---|---|---|---|
| **A. env 标记** `ROLL_SCHEDULE_INVOCATION=<invocation.id>` | 所有继承了 exec 环境的进程，不论 session / pgid 怎么变：MCP 子进程及其孙进程（Chromium）、bash 里起的 node / python 守护进程 | Linux：`/proc/<pid>/environ`。macOS：`ps` 只取 `pid=,pgid=,stat=`，**不读 env 也不读 argv**（`-E` 的 argv/env 无法区分，且会把同 uid 全部进程的环境变量拉进内存）；已 `setsid` 离开 B/C 的进程在 darwin 上是文档化残余，收回方案见 #238 | POSIX（Linux 有 A；darwin 仅 B/C） |
| **B. exec 自己的进程组** | 直接子进程（stdio MCP server）及未换组的孙进程 | 同一次 `ps` 的 `pgid` 列 / `/proc/<pid>/stat` 第 5 字段 | POSIX |
| **C. bash 工具登记的进程组** | 每条 bash 命令自成的 session（`&` 后台、`nohup`），含平台二进制 | runtime 在 spawn 时把 `ChildProcess` 交给 core 的 `ProcessGroupLedger`；按 `pgid = child.pid` 枚举 | POSIX |

**为什么不能只用 A**（实测，macOS 26.7）：`ps -E` 只对**非平台二进制**展示 env。`/opt/homebrew/bin/node`、`/usr/bin/python3`（execs 到 CommandLineTools）可见；`/bin/bash`、`/bin/sleep` 这类 Apple 平台签名（`Platform identifier=26`）的进程不可见。bash 工具的 shell 正是平台二进制，所以需要 C。Linux 上 `/proc/*/environ` 对同 uid 可读，A 就覆盖 C（C 仍生效，无害）。

**为什么 B、C 按 pgid 枚举是安全的**（高概率，XNU `forkproc` 检查 `pgfind` / `session_find`；Linux `struct pid` 被 pgid 引用计数保活）：一个 pid 号只要还是某个非空进程组的 pgid 就不会被复用。因此「首领已退出但组非空 ⇒ 组里都是我们的」。反向守卫：登记的首领已退出（`child.exitCode !== null || child.signalCode !== null`，即 Node 已 `waitpid` 回收）而快照里又出现同号进程 ⇒ pid 已被复用 ⇒ 整组跳过并记日志。**同号僵尸也算复用**：被回收的首领不可能再以僵尸形态出现，所以同号僵尸必然属于别的父进程（反驳者在真机上用 pid 空间回绕复现过「僵尸豁免」会误杀无关进程）。Linux 上 `/proc/<pid>/stat` 的 `Z` 只有在 `/proc/<pid>/task` 仅剩一项时才算死亡——主线程已退出、其他线程仍在跑的进程状态也是 `Z`，但它活着且可被信号终止（容器实测）。

**自身排除**：exec 自己的 pid 永远排除；做快照的 `ps` 子进程（在 exec 组内）按 `spawnSync().pid` 排除；`ps` 以只含 `LC_ALL=C` 的干净 env 启动，不带标记。

**B 的守卫**：只有当 exec 是组首领（快照里 `self.pgid === self.pid`，daemon / inline 都以 `detached: true` 拉起）才启用 B；手工在脚本里非 detached 运行 `roll schedule exec` 时 B 关闭，避免误杀父 shell。

**前一次尝试的残留**：同一 invocation 重试时，标记相同（Linux A 自动覆盖非平台二进制）；登记组写入 `tree_tracked_pgids`（含 `leaderState` + spawn 时的 start token）随 retry 带走，下次 preflight 的 scope = 当前 ledger ∪ 持久化 groups ∪ 上一任 `executor.pid`。恢复时若 persist 为「首领仍活」且 start token 匹配，不得把同号 PID 当成复用而跳过整组；token mismatch 后该 PGID 在本次 teardown 内永久隔离，即使 leader 随后退出也不能重新按 orphan group 纳入。core-managed Agent 的 `startAgent` 始终传显式 env 并剔离 `ROLL_SCHEDULE_INVOCATION`，避免共享 Agent 继承 marker 后被 settle 误杀；on-demand stdio MCP 仍走 `buildStdioChildEnv`，不全局剥离（那是 Linux source A 找 Chromium 的路径）。

## 5. 组件设计

### 5.1 runtime：把 spawn 出的子进程交出去（纯管道，3 处各 1–3 行）

- `bash/exec.ts` `RunBashOptions.onSpawn?: (child: ChildProcess) => void`，`deps.spawn` 成功且 `child.pid !== undefined` 时回调。
- `tool-bridge/bash-tool.ts` `SessionBashSettings.onCommandSpawn?: (child: ChildProcess) => void`，透传给 `exec({ onSpawn })`。
- `engine/conversation-engine.ts` `ConversationEngineOptions.onShellCommandSpawn?`，由 `resolveShellSettings` 放进 `SessionBashSettings.onCommandSpawn`。抽成导出的纯函数 `buildSessionBashSettings()` 便于测试。
- session-exec（`roll__exec`，`runtime.shell.session.enabled` 开启时）的 shell 由 `SessionManager.spawn` 拉起，同样经 `SessionManagerOptions.onSpawn` 登记：`close()` 只收尾未终态的会话，已完成的会话留在其进程组里的孤儿必须靠登记组才找得到（反驳者在 macOS 上复现过不登记时 settle 返回 `clean` 而 `/bin/sleep` 仍存活）。
- 不按 hostMode 判断：只有 scheduler host 传这个回调，`roll chat` 不受影响。

### 5.2 core：`scheduler-host/invocation-tree.ts`（新）

```ts
export const SCHEDULE_INVOCATION_ENV = "ROLL_SCHEDULE_INVOCATION";      // paths.ts
export interface ProcessSnapshotEntry { pid; pgid; zombie; marked }
export function snapshotProcesses(marker, platform?): ProcessSnapshot | undefined  // win32 → undefined
export class ProcessGroupLedger { track(child); groups(): readonly TrackedProcessGroup[] }
export function trackedGroupsFromPersisted(groups): TrackedProcessGroup[]  // 保留 leaderState / startToken，origin=restored；数字 pgid → unknown
export function trackedGroupsFromPersistedPgids(pgids): TrackedProcessGroup[]  // 纯数字 → leaderState: unknown（不是伪造的 exited）
export interface InvocationTreeScope { invocationId; selfPid; trackedGroups; previousExecutorPid? }
export function collectTreeMembers(snapshot, scope, deps?): { pids; skippedReusedGroups; unverifiableGroups }  // 纯函数；in-process live 组 mismatch 才跳过；恢复组 live leader 必须 token 正向 match，缺失 / unavailable 进 unverifiableGroups
export function probeInvocationTreeSettled(scope): "settled" | "unsettled" | "unavailable"  // 只快照，不发信号；unverifiableGroups 非空 → unavailable
export const INVOCATION_TREE_TEARDOWN_OUTCOMES = { clean, survivors, unavailable, unsupported }
export async function terminateInvocationTree(scope, deps?): Promise<InvocationTreeTeardown>
```

`terminateInvocationTree`：快照 → **恢复组身份不可验证（缺 start token、验证 `unavailable`、或 `leaderState: unknown` 的 live leader）⇒ `unavailable`**：首帧即不可验证时不发任何信号；**每一轮轮询都必须检查 `unverifiableGroups`**，中途变 unavailable 立即返回、不升级 SIGKILL（已发出的 SIGTERM 不撤回，报告仍为 `unavailable`）。start token 验证的 `process-not-found`（首领在 `ps -A` 采样之后、逐组 `ps -p` 之前退出）是独立 verdict `gone`，**不是 PID 复用**：pid 仍是非空组的 pgid 时内核不会复用它，所以无首领的组按 pgid 归本次运行、照常发信号，不进 quarantine；只有 `leaderState: exited` 的持久化组遇到同号 live pid 才按复用跳过；成员为空 ⇒ `clean`；否则对每个成员 `SIGTERM` → 每 250 ms 重新快照，≤ 2 s 内为空 ⇒ `clean`（附 `terminatedPids`）→ 否则 `SIGKILL` → 再等 ≤ 2 s → **以最终快照为准**：仍有成员 ⇒ `survivors`（附 `survivorPids`）。`kill` 的 `ESRCH` / `EPERM` 只是忽略——`EPERM` 的进程若在 grace 内自行退出，不能算 survivor（否则把 fail-closed 变成无谓的重跑）；其他错误向上抛。deadline 用 `performance.now()`（单调时钟，墙钟回拨不会把轮询变成无界）。快照失败（`/bin/ps` 缺失 / 超时 / `/proc` 不可读）或**快照里没有 exec 自己的 pid**（自身必然存活，缺席即快照不完整——例如 `/proc` 被空 tmpfs 覆盖）⇒ `unavailable`；测试注入的 `snapshot` 返回 `undefined` 不得回退真实 `ps`/`/proc`。`teardownTree` 抛异常由 `executeInvocation` 按 `unavailable` 处理，异常原文进 `report.error`、账本失败文案与 exec 日志。win32 ⇒ `unsupported`。总耗时上限约 4.5 s，远小于 daemon 的 10 s grace。

**跨帧隔离**：token mismatch 的 PGID 进入本次 teardown 的单调 quarantine；后续帧即使 leader 退出，也不能重新通过组判据进入 signal 集合。精确 invocation marker 仍可单独证明某个成员属于本次运行。

### 5.3 core：`execute-invocation.ts` 的两个 choke point

`ExecuteInvocationOptions.teardownTree: (phase: "preflight" | "settle") => Promise<InvocationTreeTeardown>`（必填，测试传 `cleanTeardown`）；`onTeardown?` 供 CLI 记日志。`isTreeSettled(report)` = `clean || unsupported`。

| 时机 | 树已清 | 有残留 / 无法枚举 |
|---|---|---|
| **preflight**（`beginInvocation` 之后、`runTurn` 之前） | 继续（清空 tree 列） | 先 `recordInvocationTree`（登记组 + survivors + 原因文案写进 `invocations.error`）；若仍有 retry 预算则 `failInvocation` → retry（带走登记组），**不跑 turn**。预算耗尽时 **不** 写 `failed` / 不 pause，返回 `unsettled`，行保持 `running` |
| **settle**（turn 成功 / 失败之后、写终态之前） | 用既有 Store API 写终态；`completeInvocation` 返回 `written` / `lost-claim` / `tree-unsettled` | **不写终态**，返回 kind `unsettled`（附 `survivorPids`），exec 非零退出；行保持 `running` |
| **interrupted**（停止信号） | best-effort teardown 并 persist，仍返回 `interrupted` 不写账本 | 同左 |

Windows：`unsupported` 视同已清（root-only 边界，与今天一致）。

### 5.4 接线

- `spawn-invocation.ts`：env 加 `[SCHEDULE_INVOCATION_ENV]: claim.invocation.id`（daemon 与 inline 共用入口；`takeScheduleExecEnv` 不删它——它就是要被继承的；bash `clean-env.ts` 与 MCP `buildStdioChildEnv` 均透传未知 key）。
- `runtime-host/engine-factory.ts` `CreateChatEngineInput.onShellCommandSpawn?` → `run-scheduled-turn.ts` → `schedule-exec.ts`：创建 `ProcessGroupLedger`，读取 `store.getInvocation(id)?.executor?.pid` 作为 `previousExecutorPid`，`teardownTree` 每次以持久化组 ∪ 最新 `ledger.groups()` 构造 scope；`trackedGroups(report)` 用 `mergeTrackedGroups` 合并持久化组与 `ledger.persisted()`，并剔除本次 teardown 已判复用的 `skippedReusedGroups`；`unsettled` 打 error 日志并 `exitCode = 1`；`terminatedPids` / `skippedReusedGroups` 打 warn。`ProcessGroupLedger` 的 start token 读取按平台解析：win32 不读（teardown `unsupported`、probe 恒 `settled`，token 永不消费，省掉每条 shell 命令一次 PowerShell）。

## 6. 状态矩阵

| 事件 | 树为空 | 有成员（可杀） | 有成员（SIGKILL 后仍在 / EPERM） | 快照不可用 |
|---|---|---|---|---|
| preflight（仍有预算） | 跑 turn | 清掉后跑 turn | `failInvocation` → retry，带走登记组，不跑 turn | 同左 |
| preflight（预算耗尽） | 跑 turn | 清掉后跑 turn | `unsettled`，保持 running，**不 pause** | 同左 |
| turn 成功 / needs_confirmation | 写终态 | 清掉后写终态 | `unsettled`，保持 running | 同左 |
| turn 失败（非中断） | `failInvocation` | 清掉后 `failInvocation` | `unsettled` | 同左 |
| interrupted | persist 已清，不写终态 | 清掉，不写 | persist 未清，不写 | persist unavailable，不写 |
| cancel（无 `--kill`） | 置终态 | — | `treeUnsettled`，提示加 `--kill` | `treeUnsettled` |
| cancel `--kill`（`claimed` / `running` / `retry`） | 杀 exec 后再 teardown 持久化树，`finalizeCancellation(expectedAttempt)` 置终态；exec 仍存活时先按 `executorAlive` 拒绝，不写 tree 列 | 清掉后置终态 | 拒绝 cancel，单例不释放 | 拒绝 cancel |
| cancel `--kill`（`pending` / 终态） | pending 直接置终态（不持有树，不做 teardown）；终态报 `terminal` | — | — | — |
| cancel `--abandon` | 强制终态 | 强制终态 | 强制终态 | 强制终态 |
| stale cancel（attempt 已变） | — | — | `ownershipChanged`，不改写新 owner | 同左 |
| pause | 停后续触发；空树 scheduled retry 放弃 | — | 未清树的 retry/running **保持**，不清 tree 列 | 同左 |
| remove | 删除空闲任务 | — | 拒绝，除非 `--abandon` | 同左 |
| worker shutdown（claimed） | 空树 claimed 置 failed | — | 带未清树的 claimed **保持** | 同左 |
| daemon `onExit` / inline `fail` | `failInvocation`（retry 或终态） | — | `treeUnsettled` → **hold** running，不 pause | 同左 |
| win32 任一 | 写（unsupported / probe 恒 settled） | — | — | — |

exec `unsettled` 退出后：daemon `onExit` → 先看 exec 进程树探活，再看账本树门禁：

- 残留在 **exec 自身进程组内** ⇒ `descendants-alive` ⇒ 行保持 `running`。
- 残留在 **组外** 且已持久化登记组 ⇒ 探活 dead 但 `failInvocation` 返回 `treeUnsettled` ⇒ 同样 hold，**不会**把组外 survivor 当成「exec 已死可重试耗尽」。`cancel --kill` 会按持久化 scope 再 teardown；清不掉只能 `--abandon`。
- 无持久化树且组外不可见 ⇒ 仍可 retry；下次 preflight 用账本 pgids。

`openScheduleStore` 注入 `treeLiveness`：`invocationTreeScopeFor(record)` 用账本 invocation id / 持久化组 / `executor.pid` 调 `probeInvocationTreeSettled`，**`selfPid` 恒为 0**（store 侧永远不是 exec 自身），`executor.pid` 只作为 `previousExecutorPid` 走复用守卫；exec 自己的写终态路径在清场成功后已清空 tree 列，不会走到这里。列为空且 `unsettled=0` 不调 probe；列非空或 `unsettled=1` 必须 probe，缺省 probe fail-closed。win32 恒 settled。`claimDue` 里被树门禁挡住的行按状态推迟：`retry` 行推 `retry_at`、`claimed` / `running` 行推 `lease_until`（各一个 lease 周期），不会每 15 s 重探。`tree_survivor_pids` 只是展示信息，损坏时读作 `[]`；`tree_tracked_pgids` 损坏才 fail-closed，错误文案带 invocation id。

**可观测性**：被门禁 hold 的行 `error` 列带清场原因（`runs` 行尾 `tree=unsettled(pid …)`），`roll schedule list` 查该任务的占用运行（`findLiveRun`），有未清树时在行尾提示 `⚠ 运行 <id>（<status>）进程树未清…用 roll schedule cancel <id> --kill 清场`；daemon 日志同样点名。

## 7. 平台边界与残余（写进用户文档）

- macOS：平台二进制的 env 不可读；纯平台二进制且已 `setsid` / daemonize 离开 bash 工具进程组的守护进程仍是残余边界（与 W14 文档一致）。
- Linux：`/proc/<pid>/environ` 对 setuid / 不同 uid / 非 dumpable 进程 `EACCES`，这类进程只能靠 B、C。
- `env -i` 清空环境后 exec 的子进程不带标记，只能靠 B、C。
- Windows：无法读其他进程 env，树退化为根进程（沿用启动身份），settle 不清场直接写终态，与今天一致；Job Object 留 v2。
- Linux `/proc/<pid>/environ` 会读到同 uid 其他进程的 env，只在内存里匹配标记后丢弃（spec 2026-08-25 已记录同 uid 本就能读 0600 账本）。darwin 的 `ps` 不带 `-E`、不取 `command=`，其他进程的 env 与 argv 都不进内存（`maxBuffer` 相应降到 16 MiB）。
- macOS 的 `ps -o command= -E` 把 argv 与 env 打在同一列、仅以空格分隔，无法区分：darwin 上 source A（env 标记）**关闭**（决策：接受 setsid / daemonize 边界，不做两次 `ps` 的 argv 前缀切分）。argv 里碰巧含 `ROLL_SCHEDULE_INVOCATION=<uuid>` 的无关进程不会被杀；已 `setsid` 离开 B/C 的 MCP Chromium / 守护进程是文档化残余。Linux 继续读 `/proc/*/environ`。收回方案见 #238（优先 SDK / runtime 显式登记外部子进程；必须扫描任意第三方进程时再做 `KERN_PROCARGS2`）。
- Linux 上 `readdirSync("/proc")` 与 `readFileSync(environ)` 没有超时；若系统里有持 mmap 锁的 D 态进程，settle 可能阻塞而不是 `unavailable`（macOS 的 `ps` 有 5 s 超时兜底）。需 Linux 实测，v1 记录为边界。

## 8. 决策记录

- **fail-closed 而不是「写终态 + 告警」**：SIGKILL 后仍存活只剩 D 态 / 无权限两种，重试也杀不掉。终局取决于残留在哪（见 §6）：exec 自身组内或已持久化的组外 survivor ⇒ 保持 running 直到操作员 `cancel --kill`（或 `--abandon`）；不再用「重试耗尽后 paused」释放单例。代价：这些极罕见情况下成功的 turn 结果只在 thread 里、不在账本。
- **grace 2 s 而非 `childTerminateGraceMs` 10 s**：残留物是后台进程，2 s 足够关 socket；总时长必须压在 daemon 的 10 s grace 之内。
- **不删 `descendants-alive` / pgid 探针**：HEAD 上有 8 处刚过三轮反驳的用例围绕它；本设计是纯增量，探针语义不变。
- **`teardownTree` 必填**：唯一调用方是 `schedule-exec.ts`，必填让遗漏在类型层暴露。
- **at-least-once 仍成立**：exec 在 settle 中被外部 SIGKILL ⇒ 行 running ⇒ lease 过期 ⇒ 探活 dead ⇒ 重跑（spec 2026-08-25:149）。
- **durable group identity 不能只存数字 PGID**：persist 必须带 `leaderState`（`alive` / `exited` / `unknown`）和 spawn 时的 start token。内部数字数组只证明曾登记过 pgid，解析为 `unknown`；旧 `{ leaderExited }` 对象和损坏 JSON 不再兼容，均作为无效 ownership 元数据 fail-closed，只能显式 `--abandon`。
- **恢复组与 in-process 组的所有权不同**：`ProcessGroupLedger` 持有 `ChildProcess` 的 live 组可以在无 token 时清场；从账本 `trackedGroupsFromPersisted` 恢复的组，live leader 只允许 start token **正向 match** 进入 signal 集合。token 缺失、验证 `unavailable`、或 `leaderState: unknown` 时整次 teardown / probe 返回 `unavailable`，保持 `treeUnsettled` 与单例占用，**不发送任何信号**（轮询中途变 unavailable 同样立即停，不升级 SIGKILL）。
- **底层终态 writer 必须先过 tree gate**：`finishInvocationAsFailedInTransaction` 在非 `force` 时拒绝未清树；pause / worker shutdown 走同一条路。`--abandon` 是唯一 force。
- **review 修复（8/27 晚，六 agent 审查后）**：`process-not-found` 不算复用（否则首领在 `ps -A` 采样期间退出会把整组隔离、报 `clean` 而孤儿存活，真实进程 13/30 复现）；`cancel --kill` 对 pending / 终态行不做 teardown、不写 tree 列（否则 attempt CAS 匹配 0 行误报 ownership-changed）；hold 住的行必须在 `list` / `runs` 可见；win32 不读 start token；store 探针 `selfPid` 恒 0；`claimDue` 按状态推迟被挡住的行；survivors 列宽松解析、tracked 列错误带 id；`recordInvocationTree` 必须带 ownership token（删除无 CAS 的 retry-only 写入）；`finalizeCancellation` 先查 exec 存活再写 tree。

## 9. 测试策略

- 纯函数：`parsePsSnapshot` / `parseProcStat` / `collectTreeMembers`（自身排除、B 首领守卫、C 复用守卫、previousExecutorPid、僵尸排除、**live-leader vs PID-reuse 双向**、**恢复组缺 token / 验证 unavailable 不进 signal 集合**）。
- Store：`retry + tree` 占单例；pause 保留 unsettled retry；remove 拒绝 live/tree-owned；tokenless tree write 不能覆盖 claimed/running；`finalizeCancellation` 的 attempt CAS；shutdown 不终态未清树的 claimed。
- 注入 `snapshot` / `kill` / `sleep` / `now` 的 `terminateInvocationTree` 矩阵：SIGTERM 即清、需 SIGKILL、survivors、unavailable、EPERM、win32 unsupported。
- 真实进程（POSIX；`node --test` 子进程不是组首领，据此验证 B 的守卫不会误杀同组进程）：① 带 environ 标记的 detached node 子进程被找到并终止，不同标记的对照进程不受影响（**Linux only**，darwin 不读 env）；② `sh -c "/bin/sleep 60 & exit 0"` 留下的孤儿 `sleep`（bash 工具残留的真实形状，平台二进制）经 C 被找到并终止；③ 标记设在测试进程自身时快照恰好只含自身、不含 `ps`（Linux only）；④ 持久化 live leader 的 token 正向匹配 / 不匹配；⑤ argv 含标记但 env 无标记的进程不进 `terminatedPids`；⑥ 恢复组首领在 `ps` 快照之后退出（过期首帧 + 真实后续帧 + 真实 matcher），孤儿仍被终止、不进隔离。
- CLI / 展示：`finalizeCancellation` 对 pending 行直接 cancelled、终态行 terminal（store）+ 真实 `roll schedule cancel <pending> --kill` e2e；`formatInvocationLine` / `formatScheduleLine` / `liveRunHint` / `invocationTreeScopeFor` 纯函数；`recordInvocationTree` 的 `error` 文案；paused 任务未清树 retry 行只探一次；损坏 survivors 列不阻塞其他任务 claim；exec 存活时 `finalizeCancellation` 不写 tree 列；旧 token 的 tree write 在 reclaim 后失效；`resolveStartTokenReader("win32")` 不读；`mergeTrackedGroups` 剔除已判复用组。
- `executeInvocation` 矩阵：preflight 拦截不跑 turn、settle survivors → `unsettled` 且行保持 running、unavailable → `unsettled`、unsupported → completed、interrupted 仍 teardown 且不写、phase 顺序。
- `createInvocationSpawner` 真实 spawn 断言子进程 env 含标记与 token。
- 对抗验证（完成前必做）：3 个独立反驳者（内核 / PID 复用与竞态；账本状态机与 daemon 交接；跨平台与 macOS 平台二进制），重跑本会话两个探针，以及有真实 LLM 配置时 `run-now --inline` 跑一条会 `nohup sleep &` 的提示词，断言 `ps` 无残留且行为 completed。

## 10. 文档与发布

- `docs/how-to-schedule-tasks.md`「不会重复执行同一次触发」段：补「运行结束先清场再落账、`unsettled` 语义、macOS 平台二进制边界」。
- `docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md` 追加第十轮条目。
- `.changeset/roll-schedule.md` 追加一条。
