---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

新增 `roll schedule` 定时任务：按周期无人值守地运行一轮 chat。

- runtime：`ScheduleStore`（SQLite，claim/lease/重试账本）、间隔触发解析、`UnattendedToolPolicy`（无人值守时 confirm 一律 deny）、`background` host mode 与来源标记（只进推理副本，不进历史）
- core：`roll schedule add|list|show|remove|pause|resume|run-now|runs|status|daemon|service`；daemon 按触发 spawn `roll schedule exec` 子进程，失败重试 3 次后自动 PAUSE 并在列表显示原因
- 配置新增 `scheduler.data-dir` / `max-schedules` / `max-concurrent-runs`
