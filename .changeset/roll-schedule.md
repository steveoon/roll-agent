---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

新增 `roll schedule` 定时任务：按周期无人值守地运行一轮 chat。

- runtime：`ScheduleStore`（SQLite，claim/lease/重试账本）、间隔触发解析、`UnattendedToolPolicy`（无人值守时 confirm 一律 deny）、`background` host mode 与来源标记（只进推理副本，不进历史）
- core：`roll schedule add|list|show|remove|pause|resume|run-now|runs|cancel|status|daemon|service`；daemon 按触发 spawn `roll schedule exec` 子进程，每次触发最多尝试 3 次（首次 + 2 次重试），耗尽后自动 PAUSE 并在列表显示原因
- 配置新增 `scheduler.data-dir` / `max-schedules` / `max-concurrent-runs`
- 安全边界：exec 子进程记录 PID + OS 启动身份，lease 过期只在证实旧进程已退出后才重跑；登记时记录 `runtime.approval` / `runtime.shell` 权限摘要，漂移即暂停并要求 `resume` 重新授权；ownership token 与账本路径读取后立即从子进程 env 清除
- 运维：daemon / service 显式固化 `--data-dir` 与 `--max-concurrent-runs`；停止时 10 秒 grace 后 SIGKILL；单次运行超过 1 小时强制终止；运行记录按每任务 100 条 / 30 天保留；`--every` 上限 365 天；`run-now --inline` 单次尝试、失败退出码 1；`bin/roll` 对 `schedule` 自动启用 `node:sqlite`
- 单例约束：同一任务同一时刻只运行一次（scheduled 与 manual 触发共用账本事务内门禁）；`roll schedule cancel <invocation-id>` 提供人工终态出口（运行中的记录必须 `--kill` 并确认 exec 进程退出后才释放单例，不可验证时只能显式 `--abandon`）；exec 以进程组运行，强制终止覆盖其后代进程（POSIX）
- Windows：服务改为 XML 注册（不受 `schtasks /TR` 261 字符限制，无 72 小时运行上限，失败后自动重启，电池供电不影响），进程身份只走 SystemRoot / ProgramFiles 下的 PowerShell 绝对路径且超时放宽到 8 秒，daemon 停止时不再发送对控制台进程无效的 `taskkill /T`，exec 子进程在 Windows 也脱离 daemon 控制台；`run-now --inline` 在进程树终止未确认或后代仍存活时保留 `running` 而不释放单例；账本每个 claim 事务最多探活 1 个过期 running 行（其余按 15 s 轮询间隔续租、下一轮再探），避免探活超时撑破 SQLite busy_timeout
