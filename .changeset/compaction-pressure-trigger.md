---
"@roll-agent/runtime": minor
---

roll chat 自动压缩触发机制重做（对齐 Codex / grok-build 的做法）：上下文压力 = 上一次真实 usage + 之后追加内容的估算，恢复会话或尚无实测时按历史估算——`/resume` 后第一条 prompt 也会触发压缩；触发后压缩必须真正减少上下文：`targetTokens` 超出时先放弃 `keep-recent-turns` 保护按目标预算保留整轮，最近一轮单独超出时在步骤边界切并保留该轮 user 消息（tool 调用/结果对不拆），最多连续 4 轮压缩直到低于阈值；轮内每个步骤后也检查压力，超阈值时暂停当前轮、压缩、并在同一个 send 内自动续跑（最多 2 次），长编码轮不再一路涨到 provider 报错。内置模型表补 `qwen3.8-max` / `qwen3.8-plus`（1M）。轮内压缩不截断最后一个步骤的工具结果（模型续跑正需要它）；暂停后无论压缩是否有进展都在同一个 send 内续跑，压缩无进展时不再重复暂停。手动 `/compact` 保持原有 `keep-recent-turns` 语义（不按目标预算升级切法）；续跑与首段共享 `runtime.max-steps` 步骤预算；轮内压缩期间被取消会发出 turn-cancelled 并持久化与取消轮一致的恢复记录与取消标记（resume 后知道本轮已停止、哪些工具副作用已发生），压缩报错会以 error 事件收尾且不回滚已持久化的前半段；RuntimeService 不再在首段 message-finish 时锁定 turn.completed，压缩阶段的失败 / 取消如实以 turn.failed / turn.cancelled 收尾。用户拒绝工具的那一步即使压力超阈值也不会暂停压缩后续跑，reject 仍然结束本轮。注入到最后一条 user 消息前的 compaction checkpoint reminder 计入压力与目标预算（学习到的 prompt overhead 剔除它、按当前 reminder 加回），`/resume` 后首轮估算不再漏掉这部分上下文。
