---
"@roll-agent/runtime": patch
---

上下文溢出中断路径在工具账本写盘失败时 fail closed，不再落盘误导性终态

`persistContextFailure` 此前丢弃了 `persistPendingToolCancellationsOrReport` 的返回值：当模型宣告 tool call 后触发 `context_length_exceeded`，而 Tool ledger 写入同时失败（磁盘满、存储约束等）时，pending 调用的取消记录没有进账本、也没有留下 uncovered 标记，但本轮仍会把「本轮已有操作开始执行，部分结果可能已经生效」的中断终态写进 transcript。结果是一条没有任何法医记录支撑的终态，且下一轮不会 fail closed。

现在该路径与另外两条中断路径（`persistFailedTurn`、`persistCancelledTurn`）行为一致：账本写盘失败即中止，不写终态，内存已由调用方回滚到 turn 起点，账本失败与溢出错误两个事件仍照常上报。
