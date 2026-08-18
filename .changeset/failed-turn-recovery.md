---
"@roll-agent/runtime": patch
---

模型调用在多步 turn 中途失败（限流 / 网络中断 / 5xx 等非上下文溢出错误）时不再把整轮从会话历史里抹掉：已完成的工具调用与结果、在途工具的账本记录、一条 runtime 恢复记录（`roll__interrupted_turn_recovery`）和失败说明会像取消路径一样持久化；首次调用就失败、没有任何进展的 turn 仍保持干净重试。取消 / 暂停后取消 / 上下文溢出 / 运行错误四条中断路径共用同一套追加与回滚实现，并以 ActiveTurn 的 segment 水位决定追加范围。已落盘的 user 和工具步骤不会重复；下一轮 prompt 中仍保留的 raw tool-call/result 至多一组且始终成对，被合法压缩裁掉的步骤由 checkpoint 或 recovery evidence 承接。

工具是否已经开始执行改为按每个模型 batch 的 occurrence 身份跟踪，不再把 provider 的 `toolCallId` 当成整轮唯一键。跨 step 或压力续跑复用同一 ID 时，新宣告但尚未执行的调用会准确记录为 `not_executed`；真正越过准入、锁与执行前复验边界后才记录为 `outcome_unknown`。恢复记录仍按可见 raw 结果的出现次数消费同 ID 账本，第二次执行不会被第一次的结果遮蔽。

ThreadStore schema v6 将工具账本升级为可恢复的 semantic WAL：每条新 `ToolExecutionRecord.id` 在 ledger 写入后保持 uncovered，直到 raw transcript 或 bounded recovery evidence 与 exact coverage 在同一 SQLite 事务提交。正常 segment、运行错误、取消和上下文溢出都通过同一 coverage 协议关闭窗口；纯溢出也会保留 bounded evidence，但不把可能再次撑爆上下文的 raw 工具结果写回。若 transcript 提交失败或进程在 ledger 与 transcript 之间退出，下一次 send、手动 compact 或重建 session 的 resume 会先原子写入恢复记录再继续；恢复写仍失败时不会调用模型或工具。uncovered ledger 不受 retention 裁剪，旧 schema 的既有记录迁移为已覆盖，连续恢复保持幂等。
