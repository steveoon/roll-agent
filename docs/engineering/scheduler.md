# Scheduler 工程约定

修改调度账本、claim/lease、重试、超时、进程清理、daemon/service 或 schedule 命令时读取。

本文承接根 [AGENTS.md](../../AGENTS.md) 的专项工程约定。下文源码路径均相对于仓库根目录。

## `roll schedule` 分层与安全边界

- `packages/runtime/src/scheduler/` 持有 `ScheduleStore`（`schedules.db`）、trigger、claim/lease、
  retry、单例与终态状态机；不要把业务能力或 OS 进程管理放进 Store。
- `packages/core/src/scheduler-host/` 持有 daemon、exec spawn、PID/start-token 探活、进程树清场、
  service metadata 与用户级 admission lock；CLI 命令只做参数/展示与 host 编排。
- scheduler 不补齐所有错过周期：最多触发一次并从 claim 时刻重新锚定；同一 schedule 的 scheduled
  与 manual invocation 共用单例门禁。
- 终态与单例释放必须 fail-closed：executor/tree 为 `alive`、`descendants-alive`、`unknown` 或
  metadata 无法解析时保持占用；只有证明 tree dead/settled 或显式 `--abandon` 才释放。
- `retry + 未清进程树` 仍占单例。Service restart/update 必须通过用户级 admission 阻止新 claim，
  replacement 以 `installing + replacementFrom + generation` 持久化恢复身份。
- `roll schedule add --max-run` 是每任务上限（60s–24h，缺省 1h）；timeout 终态重分类必须使用
  original attempt + `timedOutAtMs` CAS，避免覆盖时限内成功或后续 attempt。

## 使用与排查

命令、操作步骤和平台限制见 [定时任务指南](../how-to-schedule-tasks.md)。
