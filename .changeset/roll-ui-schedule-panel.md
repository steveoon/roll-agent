---
"@roll-agent/core": minor
"@roll-agent/runtime": patch
---

roll ui 新增「定时任务管理」面板（与 Companion 分区平级）：

- 服务卡片：安装 / 重启 / 卸载开机自启调度服务，显示 daemon 存活、数据目录、下次唤醒与固化二进制是否过期；未安装但有 active 任务、上次安装未完成（fail-closed）、binary 过期等状态给出警示
- 任务列表：间隔、下次运行、上次错误、运行中标记；逐任务暂停 / 恢复（恢复按当前配置重新授权）
- 最近运行：跨任务合并的运行记录，含状态、尝试次数、耗时与可展开的失败原因；排队中可取消，运行中提供「终止并取消」（等价 `cancel --kill`，需确认）；`--force` / `--abandon` 只在 CLI 提供
- 新增 `/api/schedule/*` 路由（session + CSRF 约束与其余 API 一致）与 `RollUiScheduleController` 契约；`roll schedule cancel` 的核心取消逻辑提炼为 `scheduler-host/cancel-invocation.ts` 供 CLI 与 Web 共用，CLI 行为不变
- 已安装 service 固化的 data-dir 与当前配置不一致时，面板顶部给出阻断性警告（旧目录任务仍会执行、下方列表与操作不涉及它们）
- `ScheduleStore` 新增事务化 `resumeSchedule(id, digest)`；Web 与 CLI 的恢复操作改用它，任务被并发删除时如实报错而非假成功
- 取消/恢复的结果提示保留 CLI 同款警告：Windows 后代进程无法验证时提示人工检查，恢复时提示权限已重新授权
