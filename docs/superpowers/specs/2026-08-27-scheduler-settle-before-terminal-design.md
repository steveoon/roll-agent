# Scheduler「先清场、再落终态」设计

日期：2026-08-27 · 基线：`ebf3093`（dev，codex W15 + review 修复之后）· 状态：待实现

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
- 不引入新的账本列、状态或 Store API；daemon / inline / cancel 的既有收尾逻辑零改动。
- `roll chat` 行为不变。

**非目标**

- 持久化 settlement / 影子状态（若日后要求「清不掉也不能丢结果」再做，是本设计的增量）。
- cgroup / Windows Job Object。
- 改 bash 工具的 `detached: true` 或 MCP SDK 的 close 语义。

## 3. 不变量

> 账本写入终态（`completed` / `needs_confirmation` / `failed` / `retry`）的那一刻，本 invocation 可枚举到的进程成员数为 0；做不到就不写终态。

推论：单例释放 = 终态写入 ⇒ 释放前旧执行者树已死。exec 根进程在写终态后残留几毫秒不违反不变量（探活只对 `running` 行有意义）。

## 4. 树的定义（三个来源取并集）

| 来源 | 覆盖 | 枚举手段 | 平台 |
|---|---|---|---|
| **A. env 标记** `ROLL_SCHEDULE_INVOCATION=<invocation.id>` | 所有继承了 exec 环境的进程，不论 session / pgid 怎么变：MCP 子进程及其孙进程（Chromium）、bash 里起的 node / python 守护进程 | macOS：`/bin/ps -A -ww -o pid=,pgid=,stat=,command= -E`；Linux：`/proc/<pid>/environ` | POSIX |
| **B. exec 自己的进程组** | 直接子进程（stdio MCP server）及未换组的孙进程 | 同一次 `ps` 的 `pgid` 列 / `/proc/<pid>/stat` 第 5 字段 | POSIX |
| **C. bash 工具登记的进程组** | 每条 bash 命令自成的 session（`&` 后台、`nohup`），含平台二进制 | runtime 在 spawn 时把 `ChildProcess` 交给 core 的 `ProcessGroupLedger`；按 `pgid = child.pid` 枚举 | POSIX |

**为什么不能只用 A**（实测，macOS 26.7）：`ps -E` 只对**非平台二进制**展示 env。`/opt/homebrew/bin/node`、`/usr/bin/python3`（execs 到 CommandLineTools）可见；`/bin/bash`、`/bin/sleep` 这类 Apple 平台签名（`Platform identifier=26`）的进程不可见。bash 工具的 shell 正是平台二进制，所以需要 C。Linux 上 `/proc/*/environ` 对同 uid 可读，A 就覆盖 C（C 仍生效，无害）。

**为什么 B、C 按 pgid 枚举是安全的**（高概率，XNU `forkproc` 检查 `pgfind` / `session_find`；Linux `struct pid` 被 pgid 引用计数保活）：一个 pid 号只要还是某个非空进程组的 pgid 就不会被复用。因此「首领已退出但组非空 ⇒ 组里都是我们的」。反向守卫：登记的首领已退出（`child.exitCode !== null || child.signalCode !== null`，即 Node 已 `waitpid` 回收）而快照里又出现同号进程 ⇒ pid 已被复用 ⇒ 整组跳过并记日志。**同号僵尸也算复用**：被回收的首领不可能再以僵尸形态出现，所以同号僵尸必然属于别的父进程（反驳者在真机上用 pid 空间回绕复现过「僵尸豁免」会误杀无关进程）。Linux 上 `/proc/<pid>/stat` 的 `Z` 只有在 `/proc/<pid>/task` 仅剩一项时才算死亡——主线程已退出、其他线程仍在跑的进程状态也是 `Z`，但它活着且可被信号终止（容器实测）。

**自身排除**：exec 自己的 pid 永远排除；做快照的 `ps` 子进程（在 exec 组内）按 `spawnSync().pid` 排除；`ps` 以只含 `LC_ALL=C` 的干净 env 启动，不带标记。

**B 的守卫**：只有当 exec 是组首领（快照里 `self.pgid === self.pid`，daemon / inline 都以 `detached: true` 拉起）才启用 B；手工在脚本里非 detached 运行 `roll schedule exec` 时 B 关闭，避免误杀父 shell。

**前一次尝试的残留**：同一 invocation 重试时，标记相同（A 自动覆盖非平台二进制）；另外把重试前账本里记录的上一任 `executor.pid` 当作一个「首领已退出」的登记组处理（覆盖上一任 exec 组里的 MCP 孙进程），同样受复用守卫保护。

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
export interface InvocationTreeScope { invocationId; selfPid; trackedGroups; previousExecutorPid? }
export function collectTreeMembers(snapshot, scope): { pids; skippedReusedGroups }   // 纯函数
export const INVOCATION_TREE_TEARDOWN_OUTCOMES = { clean, survivors, unavailable, unsupported }
export async function terminateInvocationTree(scope, deps?): Promise<InvocationTreeTeardown>
```

`terminateInvocationTree`：快照 → 成员为空 ⇒ `clean`；否则对每个成员 `SIGTERM` → 每 250 ms 重新快照，≤ 2 s 内为空 ⇒ `clean`（附 `terminatedPids`）→ 否则 `SIGKILL` → 再等 ≤ 2 s → **以最终快照为准**：仍有成员 ⇒ `survivors`（附 `survivorPids`）。`kill` 的 `ESRCH` / `EPERM` 只是忽略——`EPERM` 的进程若在 grace 内自行退出，不能算 survivor（否则把 fail-closed 变成无谓的重跑）；其他错误向上抛。deadline 用 `performance.now()`（单调时钟，墙钟回拨不会把轮询变成无界）。快照失败（`/bin/ps` 缺失 / 超时 / `/proc` 不可读）⇒ `unavailable`；`teardownTree` 抛异常由 `executeInvocation` 按 `unavailable` 处理。win32 ⇒ `unsupported`。总耗时上限约 4.5 s，远小于 daemon 的 10 s grace。

### 5.3 core：`execute-invocation.ts` 的两个 choke point

`ExecuteInvocationOptions.teardownTree: (phase: "preflight" | "settle") => Promise<InvocationTreeTeardown>`（必填，测试传 `cleanTeardown`）；`onTeardown?` 供 CLI 记日志。`isTreeSettled(report)` = `clean || unsupported`。

| 时机 | 树已清 | 有残留 / 无法枚举 |
|---|---|---|
| **preflight**（`beginInvocation` 之后、`runTurn` 之前） | 继续 | `failInvocation`（非 terminal → 走既有 retry / 耗尽后 paused），**不跑 turn**——避免「杀不掉的残留」每次重试都重跑一遍 turn |
| **settle**（turn 成功 / 失败之后、写终态之前） | 用既有 Store API 写终态 | **不写终态**，返回新 kind `unsettled`（附 `survivorPids`），exec 非零退出；行保持 `running`，交给 daemon `onExit` / `settleInlineInvocation` 既有逻辑（探活 dead → `failInvocation` → retry → preflight 再拦） |
| **interrupted**（停止信号） | best-effort teardown，仍返回 `interrupted` 不写账本 | 同左 |

Windows：`unsupported` 视同已清（root-only 边界，与今天一致）。

### 5.4 接线

- `spawn-invocation.ts`：env 加 `[SCHEDULE_INVOCATION_ENV]: claim.invocation.id`（daemon 与 inline 共用入口；`takeScheduleExecEnv` 不删它——它就是要被继承的；bash `clean-env.ts` 与 MCP `buildStdioChildEnv` 均透传未知 key）。
- `runtime-host/engine-factory.ts` `CreateChatEngineInput.onShellCommandSpawn?` → `run-scheduled-turn.ts` → `schedule-exec.ts`：创建 `ProcessGroupLedger`，读取 `store.getInvocation(id)?.executor?.pid` 作为 `previousExecutorPid`，`teardownTree` 每次以最新 `ledger.groups()` 构造 scope；`unsettled` 打 error 日志并 `exitCode = 1`；`terminatedPids` / `skippedReusedGroups` 打 warn。

## 6. 状态矩阵

| 事件 | 树为空 | 有成员（可杀） | 有成员（SIGKILL 后仍在 / EPERM） | 快照不可用 |
|---|---|---|---|---|
| preflight | 跑 turn | 清掉后跑 turn | `failInvocation` → retry，不跑 turn | 同左 |
| turn 成功 / needs_confirmation | 写终态 | 清掉后写终态 | `unsettled`，保持 running | 同左 |
| turn 失败（非中断） | `failInvocation` | 清掉后 `failInvocation` | `unsettled` | 同左 |
| interrupted | 不写 | 清掉，不写 | 不写，日志 | 不写 |
| win32 任一 | 写（unsupported） | — | — | — |

exec `unsettled` 退出后：daemon `onExit` → `probeExecutor`（pgid 探针）：

- 残留在 **exec 自身进程组内**（例如 MCP server 的 D 态 / 异 uid 子进程）⇒ `descendants-alive` ⇒ 行保持 `running`，lease 持续续约，该任务不再触发，`maxRunMs` 后 daemon 只再强杀不落账；`cancel --kill` 会以 executorAlive / treeKillFailed 拒绝，**只能 `cancel --abandon` 放弃**。这是第七轮既有的 fail-closed hold，本设计只是把原本会写 `completed` 的成功 turn 也路由进去；残留 pid 只在 exec 日志里。
- 残留在 **组外** ⇒ 探活 dead ⇒ `failInvocation` ⇒ retry ⇒ preflight：能再次发现的只有 env 可见的进程和上一任 exec 进程组里的进程；bash 工具登记的进程组是 exec 进程内的内存对象，不跨 attempt——macOS 上纯平台二进制、任何平台上的异 uid 残留在重试时不可见，turn 会重跑（最多 `retryBudget` 次），耗尽后 paused 的原因是 daemon 的通用「exec 进程退出 code=1」而不含 pid。

无一格需要 daemon / inline / cancel 改动。

## 7. 平台边界与残余（写进用户文档）

- macOS：平台二进制的 env 不可读；纯平台二进制且已 `setsid` / daemonize 离开 bash 工具进程组的守护进程仍是残余边界（与 W14 文档一致）。
- Linux：`/proc/<pid>/environ` 对 setuid / 不同 uid / 非 dumpable 进程 `EACCES`，这类进程只能靠 B、C。
- `env -i` 清空环境后 exec 的子进程不带标记，只能靠 B、C。
- Windows：无法读其他进程 env，树退化为根进程（沿用启动身份），settle 不清场直接写终态，与今天一致；Job Object 留 v2。
- `ps -E` 会读到同 uid 其他进程的 env，只在内存里匹配标记后丢弃（spec 2026-08-25 已记录同 uid 本就能读 0600 账本）。
- macOS 的 `ps -o command= -E` 把 argv 与 env 打在同一列、仅以空格分隔，无法区分：任何同 uid 进程只要 argv 里含精确的 `ROLL_SCHEDULE_INVOCATION=<uuid>` 串（典型是操作员在 preflight/settle 窗口内 `grep` 该标记）就会被当作树成员终止。Linux 用 `/proc/<pid>/environ` 整条精确匹配，不受影响。若要收紧可再跑一次不带 `-E` 的 `ps` 剔除 argv 前缀，v1 记录为边界。
- Linux 上 `readdirSync("/proc")` 与 `readFileSync(environ)` 没有超时；若系统里有持 mmap 锁的 D 态进程，settle 可能阻塞而不是 `unavailable`（macOS 的 `ps` 有 5 s 超时兜底）。需 Linux 实测，v1 记录为边界。

## 8. 决策记录

- **fail-closed 而不是「写终态 + 告警」**：SIGKILL 后仍存活只剩 D 态 / 无权限两种，重试也杀不掉。终局取决于残留在哪（见 §6）：exec 自身组内 ⇒ 保持 running 直到操作员 `cancel --abandon`；组外且重试时可见 ⇒ preflight 拦截、耗尽后 paused；组外且不可见（macOS 平台二进制 / 异 uid）⇒ 最多重跑 `retryBudget` 次后 paused。代价：这些极罕见情况下成功的 turn 结果只在 thread 里、不在账本。
- **grace 2 s 而非 `childTerminateGraceMs` 10 s**：残留物是后台进程，2 s 足够关 socket；总时长必须压在 daemon 的 10 s grace 之内。
- **不删 `descendants-alive` / pgid 探针**：HEAD 上有 8 处刚过三轮反驳的用例围绕它；本设计是纯增量，探针语义不变。
- **`teardownTree` 必填**：唯一调用方是 `schedule-exec.ts`，必填让遗漏在类型层暴露。
- **at-least-once 仍成立**：exec 在 settle 中被外部 SIGKILL ⇒ 行 running ⇒ lease 过期 ⇒ 探活 dead ⇒ 重跑（spec 2026-08-25:149）。

## 9. 测试策略

- 纯函数：`parsePsSnapshot` / `parseProcStat` / `collectTreeMembers`（自身排除、B 首领守卫、C 复用守卫、previousExecutorPid、僵尸排除）。
- 注入 `snapshot` / `kill` / `sleep` / `now` 的 `terminateInvocationTree` 矩阵：SIGTERM 即清、需 SIGKILL、survivors、unavailable、EPERM、win32 unsupported。
- 真实进程（POSIX；`node --test` 子进程不是组首领，据此验证 B 的守卫不会误杀同组进程）：① 带标记的 detached node 子进程被找到并终止，不同标记的对照进程不受影响；② `sh -c "/bin/sleep 60 & exit 0"` 留下的孤儿 `sleep`（bash 工具残留的真实形状，平台二进制）经 C 被找到并终止；③ 标记设在测试进程自身时快照恰好只含自身、不含 `ps`。
- `executeInvocation` 矩阵：preflight 拦截不跑 turn、settle survivors → `unsettled` 且行保持 running、unavailable → `unsettled`、unsupported → completed、interrupted 仍 teardown 且不写、phase 顺序。
- `createInvocationSpawner` 真实 spawn 断言子进程 env 含标记与 token。
- 对抗验证（完成前必做）：3 个独立反驳者（内核 / PID 复用与竞态；账本状态机与 daemon 交接；跨平台与 macOS 平台二进制），重跑本会话两个探针，以及有真实 LLM 配置时 `run-now --inline` 跑一条会 `nohup sleep &` 的提示词，断言 `ps` 无残留且行为 completed。

## 10. 文档与发布

- `docs/how-to-schedule-tasks.md`「不会重复执行同一次触发」段：补「运行结束先清场再落账、`unsettled` 语义、macOS 平台二进制边界」。
- `docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md` 追加第十轮条目。
- `.changeset/roll-schedule.md` 追加一条。
