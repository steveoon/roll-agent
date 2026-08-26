# 如何用 roll schedule 定时运行一轮 chat

目标：让 roll 在没人盯着终端的时候，按固定周期无人值守地跑一轮 `roll chat`，并把每次运行的结果和失败原因留在本地账本里。

## 前置条件

- 已配置 LLM（`roll doctor` 通过，`roll chat "hi" --json` 能返回 `completed`）。
- Node.js ≥ 22.6，`roll` 已安装（`roll --version`）。22.6–22.12 上 `roll` 启动器会自动为 `schedule` 子命令附加 `--experimental-sqlite`。

## 步骤

1. 登记任务（`--now` 让它登记后立刻触发一次）：

   ```bash
   roll schedule add "检查未读消息并汇总，不要调用需要确认的工具" \
     --name 巡检 --every 30m --cwd ~/work --now
   ```

   `--every` 接受 `Ns` / `Nm` / `Nh` / `Nd`，最短 60 秒、最长 365 天；`--cwd` 决定运行时的工作目录（默认当前目录），运行时的 LLM / Agent / 审批配置按该目录解析，而任务账本始终写在登记时解析出的 `scheduler.data-dir`。登记时会记录该目录下 `runtime.approval` / `runtime.shell` 的权限边界摘要。

2. 前台试跑 daemon，观察第一次触发：

   ```bash
   roll schedule daemon --foreground
   ```

   15 秒内应看到 `触发 巡检（schedule=… invocation=…）` 和 `invocation … 完成`。Ctrl+C 退出。

3. 安装为用户级常驻服务（macOS LaunchAgent / Windows 当前用户 Scheduled Task，随登录启动；Windows 任务通过 XML 注册，不受 `schtasks /TR` 261 字符限制，无运行时长上限，失败后每分钟重启最多 3 次，电池供电不影响启动）：

   ```bash
   roll schedule service install
   roll schedule service status
   ```

4. 查看结果：

   ```bash
   roll schedule list                # 每个任务的状态、周期、下次运行、上次失败原因
   roll schedule runs <id>           # 历次运行：completed / needs_confirmation / failed、thread id
   roll schedule status              # daemon 是否存活、任务统计、下次唤醒时间
   roll chat --session <threadId>    # 打开某次运行的线程继续对话
   ```

## 运行时的行为

- **无人值守**：每次触发起一个新 thread，以 `background` 模式运行。需要人工确认的工具调用会被策略直接拒绝，模型会跳过并在结尾说明；这样的运行记为 `needs_confirmation`，调度照常推进。
- **失败与重试**：exec 子进程抛错或非零退出 → 10 秒后重试，每次触发最多尝试 3 次（首次 + 2 次重试）；用完后任务自动 `paused`，`roll schedule list` 会显示原因。修好后 `roll schedule resume <id>`。`pause` 会立即放弃该任务尚未开始的重试。
- **权限边界漂移即停**：每次执行前会把当前 `runtime.approval` / `runtime.shell` 配置的摘要与登记时对比，不一致（无论放宽还是收紧）都不会运行，任务直接 `paused` 并给出原因。摘要只覆盖审批策略与 shell 开关，不覆盖已注册 Agent / skills 的变化。`roll schedule resume <id>` 同时是「重新授权」：它总会以 `--cwd` 目录当前的配置重新记录摘要（对 active 任务也一样），摘要变化时会打印提示。
- **不会重复执行同一次触发**：exec 子进程会把自己的 PID 与 OS 启动身份写进账本；即使 daemon 被强杀、机器休眠后 lease 过期，只有在证实旧子进程**整个进程组**已经退出后才会重新执行（根进程已退出但 MCP 等留在 exec 进程组里的后代仍存活时同样算「还在运行」）。POSIX 内建 shell 工具仍在自己的独立进程组中；Roll 主动取消、单次运行超时、daemon 停止或孤儿清理时，会先用 SIGTERM 让 exec 取消 active turn，由 Bash 自己终止其进程组，grace 内未退出才升级 SIGKILL。命令若自行再次 `setsid` / daemonize，或 exec 遭外部 SIGKILL / 系统崩溃，仍可能逃离这条协作清理链。Windows 的 PowerShell 后端不 detached，仍在 exec 进程树内。无法证实时一直等待（`roll schedule runs` 里可以看到它仍是 `running`）。Windows 没有进程组语义，只能确认根进程（exec 派生的 MCP 子进程若在根退出后仍存活，不会阻止下一轮）。单次运行超过 1 小时会被 daemon 终止并按失败重试——包括上一个 daemon 留下的孤儿子进程。这套机制保证的是「不会同时运行两个由 Roll 管理且可验证存活的执行进程树」，不是严格的 exactly-once：已经发出的消息、写过的文件不会回滚。
- **错过的触发只补一次**：机器睡眠后醒来，不会把错过的周期一次性补跑；下次运行时间从「现在」重新计算。
- **同一任务同一时刻只运行一次**：无论 scheduled 还是 manual 触发，账本事务里都会拒绝在已有 `claimed` / `running` 记录时再启动一次。周期触发遇到上一轮未结束会跳过并重新计算下次时间；`run-now` 入队的记录会等上一轮结束后由 daemon 执行；`run-now --inline` 遇到运行中的任务直接退出 1。
- **手动触发**：`roll schedule run-now <id>` 入队交给 daemon；`--inline` 在当前进程内执行并等待结果，不依赖 daemon，**只尝试一次**，非 `completed` / `needs_confirmation` 时退出码为 1（Ctrl+C 会转发给 exec 子进程）。手动触发的失败不会暂停任务；对 `paused` 的任务也可以 `run-now`（权限漂移检查照常生效），便于修好后先试跑再 `resume`。 `--inline` 遇到 exec 根进程退出但进程树终止未被确认、或进程组仍有存活成员的情况，与 daemon 一样保留 `running`、不释放单例（退出码 1），可用 `roll schedule cancel --kill` 收尾。
- **取消一次运行**：`roll schedule cancel <invocation-id>` 对排队中（`pending` / `retry`）和尚未启动（`claimed`）的记录直接置终态并作废 token。对 `running` 的记录，取消必须加 `--kill`：POSIX 先 SIGTERM 请求 active turn 与 Bash 协作清理，grace 后仍存活才 SIGKILL；Windows 直接 `taskkill /T /F`。只有确认 exec 进程组已退出后才置终态（Windows 只能确认根进程：`--kill` 取消总会打印「后代不可验证」告警，`--json` 时体现为 `unverifiedDescendants: true`，只有探活为 unknown 时才需要 `--abandon`）；进程树无法整体终止（`taskkill` 失败、或该进程不是进程组首领）时不会退回只杀根进程，取消被拒绝、单例不释放；`--kill` 与 `--abandon` 互斥。探活永远是 unknown 的记录（例如平台读不到进程身份）只能用 `--abandon` 放弃追踪——这是危险操作，旧进程若还活着，其副作用不会被阻止。
- **暂停 / 恢复不改相位**：`pause` 后 `resume`，仍按原来的下次运行时间执行。
- **停止 daemon**：POSIX 收到 SIGTERM / SIGINT / SIGHUP 后先给子进程树 SIGTERM，10 秒内未退出则 SIGKILL；Windows 没有可投递给控制台进程的优雅信号，daemon 收到 Ctrl+C / Ctrl+Break 后直接等待 10 秒 grace 再 `taskkill /T /F`；`roll schedule service uninstall`（`schtasks /End`）在 Windows 是强制终止，daemon 没有机会处理子进程，在跑的 exec 由下一次 daemon 的探活规则收尾。进程树信号发送失败时不会单独终止根进程，日志标明「未整体终止」。任何时候 exec 根进程退出而最近一次进程树终止未被确认、或进程组里仍有存活成员，daemon 都不会把这次运行记为失败或重试，记录保持 `running`，交给探活规则与 1 小时上限处理。 Windows 上关闭 daemon 的控制台窗口（SIGHUP）时系统只给数秒，daemon 会跳过 grace 立即 `taskkill /T /F`。exec 子进程在 Windows 以 detached 方式启动，不再由 daemon 的 libuv job object 连带结束；`service stop` / `schtasks /End` 是否仍会结束它取决于 Task Scheduler 自身的 job object（需真机确认）——若存活，它会继续运行直到自己写入结果，卡住的由下一个 daemon 在 1 小时后收拾。
- **运行记录保留**：每个任务最多保留最近 100 条终态记录、最长 30 天，daemon 每轮自动清理。每次运行创建的 chat 线程不随账本清理，仍可用 `roll chat --session <threadId>` 打开。

## 配置

```yaml
scheduler:
  data-dir: ~/.roll-agent/scheduler   # schedules.db、scheduler.log、daemon.json 所在目录
  max-schedules: 50
  max-concurrent-runs: 2               # daemon 同时运行的 exec 子进程数
```

`data-dir` 写相对路径时以配置文件所在目录为基准（不随执行命令的目录变化）。`roll schedule service install` 会把安装时解析出的 `data-dir` 与 `max-concurrent-runs` 固化进服务定义（`roll schedule daemon --foreground --data-dir … --max-concurrent-runs …`），之后修改配置需要重新 `install`。daemon 传给 exec 子进程的账本位置同样是显式指定的，不会因 `--cwd` 目录里另有一份配置而写错账本。`add / list / runs / status / run-now` 这些管理命令按当前目录的配置解析账本位置，要和 daemon 看同一个账本，请在同一配置范围内执行（`roll schedule status` 会打印它使用的 `data-dir`）。

## 目前的限制

- v1 只有间隔触发；「每个工作日 9 点」这类日历触发和时区支持在后续版本。
- 模型不能自己创建定时任务（没有 `/loop` 或 `roll__schedule` 工具），只有 CLI 管理面。
- 每次触发都是新线程，不会续接上一次的上下文。
- 常驻服务仅支持 macOS 与 Windows；Linux 请用 systemd user unit 运行 `roll schedule daemon --foreground`。
- Windows：exec 子进程与 daemon 的启动身份通过 `%SystemRoot%`（或 `%WINDIR%`）`\System32\WindowsPowerShell\v1.0\powershell.exe`（或 `%ProgramFiles%\PowerShell\7\pwsh.exe`）读取，单次超时 8 秒；Node 22.6–22.12 下手动运行 `roll schedule daemon --foreground` 会经启动器再起一个进程（服务安装路径不受影响，flag 已固化进任务定义），建议 Windows 使用 Node ≥ 22.13。
