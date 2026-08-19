---
"@roll-agent/runtime": patch
---

中断终态写入统一以工具账本为门，暂停路径补齐账本写入，溢出文案改由账本执行状态派生

- `appendInterruptedTurnMessages` 新增账本门：`pendingToolCalls` 仍有未入账调用时拒绝写入任何中断终态并上报错误，使「先账本、后终态」从四条中断路径各自的纪律变成漏斗处的结构性约束
- `persistPausedTurnCancellation`（轮内压力暂停）此前是唯一不经 `persistPendingToolCancellationsOrReport` 就写终态的中断路径，现与其余三条对齐：账本写入失败即中止，以降级文案上报取消
- 上下文溢出标记的「本轮已有操作开始执行」提示改由账本记录的执行状态派生：仅宣告即取消（`executionState=not_executed`）、策略拒绝、用户拒绝、输入校验失败的调用不再触发该提示，散文与同批持久化的账本证据不再互相矛盾
