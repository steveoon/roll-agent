---
"@roll-agent/runtime": patch
---

模型调用在多步 turn 中途失败（限流 / 网络中断 / 5xx 等非上下文溢出错误）时不再把整轮从会话历史里抹掉：已完成的工具调用与结果、在途工具的 outcome_unknown 账本记录、一条 runtime 恢复记录（`roll__interrupted_turn_recovery`）和失败说明会像取消路径一样持久化，下一轮模型能看到哪些副作用已经发生，不会因用户重试而重复执行；首次调用就失败、没有任何进展的 turn 仍保持干净重试。取消 / 暂停后取消 / 上下文溢出 / 运行错误四条中断路径共用同一套「追加记录 + 持久化 + 失败回滚」实现，并以 ActiveTurn 上的 segment 落盘水位（已持久化 step 集合 + user 是否已落盘）决定追加范围：压力暂停后的续跑段被取消 / 失败时只追加尚未落盘的步骤与记录，durable transcript、活动历史和下一轮 prompt 里 user 与 tool-call/result 各恰好一次；上下文溢出后不把本段（尚未落盘的）raw 工具步骤写回历史以免立刻再次溢出：溢出失败只保留账本与说明标记；溢出恢复压缩期间被取消时同样不重复 user、不写回 raw，改由恢复记录以 bounded evidence 列出这些步骤的执行结果，模型仍能知道它们已执行。纯溢出失败路径的 bounded evidence 留作后续增强。
