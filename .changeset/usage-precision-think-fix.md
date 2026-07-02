---
"@roll-agent/core": patch
"@roll-agent/runtime": minor
---

用量统计精度提升与 qwen think 标签泄漏修复。

- **context window 表**：补 `claude-sonnet-5` / `claude-opus-4-7` / `claude-opus-4-6` 条目（均 1M，依据官方模型文档）。此前 `claude-sonnet-5` 落到通用 `claude` 兜底 200k，状态栏余量低报 5 倍。
- **SessionTokenUsage** 新增 `cacheWriteTokens`（映射 AI SDK v7 `inputTokenDetails.cacheWriteTokens`，session 累计同步）；`message-finish` 事件新增 `outputTokensPerSecond`（取自 v7 finish-step performance stats）。
- **状态栏**：`in` 段显示 cache write（`(+800 cached, +200 cache-write)`）；新增 `· N tok/s` 输出吞吐段。
- **状态栏响应式两档**：按终端宽度自适应——宽度足够显示完整标签（`turn in … (+cached) out …`、`session …`、`(90% left)`）；不足时切紧凑档（`↑215.2k ↓307`、`Σ374.5k`、`43t/s`、ctx 去掉百分比括号）；仍不足按 tok/s → session → turn → think 优先级丢段，model 与 ctx 永远保留，不再出现中段截断。`formatTokens` 支持 M 单位并去除尾零（`1000.0k`→`1M`、`200.0k`→`200k`）。
- **think 标签泄漏修复**：qwen 等模型将 `<think>` 推理内联在文本流中，当 thinking 跨越工具调用时开/闭标签被分到不同历史段，导致 `</think>` 字面量泄漏、推理文本按正文亮色渲染。`parseThinking` 兜底处理无开标签的闭标签；流式状态机跨段携带 think 开闭状态（提交时补 `<think>` 前缀，live 区同步）。
