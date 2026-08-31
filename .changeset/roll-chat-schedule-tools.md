---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

roll chat 新增内建定时任务工具，自然语言即可创建定时任务：

- `roll__schedule_create`：登记按固定间隔运行的任务；创建前以规范化对象展示完整参数与权限边界确认（批准一次只授权这一个任务），确认到创建之间配置 / 权限漂移则 fail-closed 放弃；相同定义（按有效单次上限比较）的 active 任务幂等返回既有记录，权限摘要不同时按新摘要重新授权并明示
- `roll__schedule_list`：只读列出任务（分页、prompt 有界摘要、附调度服务就绪状态）；账本以真正只读方式打开（`readScheduleLedger`：不存在返回空、schema 不符拒读且绝不自动迁移）
- 无人值守（定时任务触发的）轮次只注册 list、不注册 create——定时任务不能繁殖定时任务；system prompt 新增 `# 定时任务` 段与无人值守说明
- `ScheduleStore` 新增 `createScheduleIdempotent`（事务内语义查重）；core 新增 `scheduler-host/schedule-tool-binding.ts` 端口——账本随会话配置、authority digest 按任务目录配置（与 `roll schedule add` 语义一致）、daemon/service 就绪探测——engine-factory 一处接线覆盖 chat / server / schedule-exec 三入口；core exports 仅新增 `./scheduler-host/schedule-tool-binding` 单条子路径
