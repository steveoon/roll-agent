---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

新增 `roll schedule` 定时任务：按周期无人值守地运行一轮 chat。

- runtime：`ScheduleStore`（SQLite，claim/lease/重试账本）、间隔触发解析、`UnattendedToolPolicy`（无人值守时 confirm 一律 deny）、`background` host mode 与来源标记（只进推理副本，不进历史）
- core：`roll schedule add|list|show|remove|pause|resume|run-now|runs|status|daemon|service`；daemon 按触发 spawn `roll schedule exec` 子进程，每次触发最多尝试 3 次（首次 + 2 次重试），耗尽后自动 PAUSE 并在列表显示原因
- 配置新增 `scheduler.data-dir` / `max-schedules` / `max-concurrent-runs`
- 安全边界：exec 子进程记录 PID + OS 启动身份，lease 过期只在证实旧进程已退出后才重跑；登记时记录 `runtime.approval` / `runtime.shell` 权限摘要，漂移即暂停并要求 `resume` 重新授权；ownership token 与账本路径读取后立即从子进程 env 清除
- 运维：daemon / service 显式固化 `--data-dir` 与 `--max-concurrent-runs`；停止时 10 秒 grace 后 SIGKILL；单次运行超过 1 小时强制终止；运行记录按每任务 100 条 / 30 天保留；`--every` 上限 365 天；`run-now --inline` 单次尝试、失败退出码 1；`bin/roll` 对 `schedule` 自动启用 `node:sqlite`
