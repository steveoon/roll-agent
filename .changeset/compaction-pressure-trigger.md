---
"@roll-agent/runtime": minor
---

roll chat 自动压缩触发机制重做（对齐 Codex / grok-build 的做法）：上下文压力 = 上一次真实 usage + 之后追加内容的估算，恢复会话或尚无实测时按历史估算——`/resume` 后第一条 prompt 也会触发压缩；触发后压缩必须真正减少上下文：`targetTokens` 超出时先放弃 `keep-recent-turns` 保护按目标预算保留整轮，最近一轮单独超出时在步骤边界切并保留该轮 user 消息（tool 调用/结果对不拆），最多连续 4 轮压缩直到低于阈值；轮内每个步骤后也检查压力，超阈值时暂停当前轮、压缩、并在同一个 send 内自动续跑（最多 2 次），长编码轮不再一路涨到 provider 报错。内置模型表补 `qwen3.8-max` / `qwen3.8-plus`（1M）。
