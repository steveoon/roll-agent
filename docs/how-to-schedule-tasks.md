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

3. 安装为用户级常驻服务（macOS LaunchAgent / Windows Scheduled Task，随登录启动）：

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
- **失败与重试**：exec 子进程抛错或非零退出 → 10 秒后重试，最多 3 次；用完后任务自动 `paused`，`roll schedule list` 会显示原因。修好后 `roll schedule resume <id>`。
- **权限边界漂移即停**：每次执行前会把当前 `runtime.approval` / `runtime.shell` 配置的摘要与登记时对比，不一致（无论放宽还是收紧）都不会运行，任务直接 `paused` 并给出原因；确认配置后 `roll schedule resume <id>` 会以当前配置重新授权。
- **不会重复执行同一次触发**：exec 子进程会把自己的 PID 与 OS 启动身份写进账本；即使 daemon 被强杀、机器休眠后 lease 过期，只有在证实旧子进程已经退出后才会重新执行，无法证实时一直等待（`roll schedule runs` 里可以看到它仍是 `running`）。单次运行超过 1 小时会被 daemon 强制终止并按失败重试。
- **错过的触发只补一次**：机器睡眠后醒来，不会把错过的周期一次性补跑；下次运行时间从「现在」重新计算。
- **手动触发**：`roll schedule run-now <id>` 入队交给 daemon；`--inline` 在当前进程内执行并等待结果，不依赖 daemon，**只尝试一次**，非 `completed` / `needs_confirmation` 时退出码为 1。手动触发的失败不会暂停任务。
- **暂停 / 恢复不改相位**：`pause` 后 `resume`，仍按原来的下次运行时间执行。
- **停止 daemon**：收到 SIGTERM 后先给子进程 SIGTERM，10 秒内未退出则 SIGKILL；仍未确认退出的运行由上面的探活规则决定是否重跑。
- **运行记录保留**：每个任务最多保留最近 100 条终态记录、最长 30 天，daemon 每轮自动清理。

## 配置

```yaml
scheduler:
  data-dir: ~/.roll-agent/scheduler   # schedules.db、scheduler.log、daemon.json 所在目录
  max-schedules: 50
  max-concurrent-runs: 2               # daemon 同时运行的 exec 子进程数
```

`roll schedule service install` 会把安装时解析出的 `data-dir` 与 `max-concurrent-runs` 固化进服务定义（`roll schedule daemon --foreground --data-dir … --max-concurrent-runs …`），之后修改配置需要重新 `install`。daemon 传给 exec 子进程的账本位置同样是显式指定的，不会因 `--cwd` 目录里另有一份配置而写错账本。

## 目前的限制

- v1 只有间隔触发；「每个工作日 9 点」这类日历触发和时区支持在后续版本。
- 模型不能自己创建定时任务（没有 `/loop` 或 `roll__schedule` 工具），只有 CLI 管理面。
- 每次触发都是新线程，不会续接上一次的上下文。
- 常驻服务仅支持 macOS 与 Windows；Linux 请用 systemd user unit 运行 `roll schedule daemon --foreground`。
