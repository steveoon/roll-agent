# 如何用 roll schedule 定时运行一轮 chat

目标：让 roll 在没人盯着终端的时候，按固定周期无人值守地跑一轮 `roll chat`，并把每次运行的结果和失败原因留在本地账本里。

## 前置条件

- 已配置 LLM（`roll doctor` 通过，`roll chat "hi" --json` 能返回 `completed`）。
- Node.js ≥ 22.13，`roll` 已安装（`roll --version`）。

## 步骤

1. 登记任务（`--now` 让它登记后立刻触发一次）：

   ```bash
   roll schedule add "检查未读消息并汇总，不要调用需要确认的工具" \
     --name 巡检 --every 30m --cwd ~/work --now
   ```

   `--every` 接受 `Ns` / `Nm` / `Nh` / `Nd`，最短 60 秒；`--cwd` 决定运行时的工作目录（默认当前目录）。

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
- **错过的触发只补一次**：机器睡眠后醒来，不会把错过的周期一次性补跑；下次运行时间从「现在」重新计算。
- **手动触发**：`roll schedule run-now <id>` 入队交给 daemon；`--inline` 在当前进程内执行并等待结果，不依赖 daemon。
- **暂停 / 恢复不改相位**：`pause` 后 `resume`，仍按原来的下次运行时间执行。

## 配置

```yaml
scheduler:
  data-dir: ~/.roll-agent/scheduler   # schedules.db、scheduler.log、daemon.json 所在目录
  max-schedules: 50
  max-concurrent-runs: 2               # daemon 同时运行的 exec 子进程数
```

## 目前的限制

- v1 只有间隔触发；「每个工作日 9 点」这类日历触发和时区支持在后续版本。
- 模型不能自己创建定时任务（没有 `/loop` 或 `roll__schedule` 工具），只有 CLI 管理面。
- 每次触发都是新线程，不会续接上一次的上下文。
- 常驻服务仅支持 macOS 与 Windows；Linux 请用 systemd user unit 运行 `roll schedule daemon --foreground`。
