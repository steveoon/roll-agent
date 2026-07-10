---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

MCP Sampling 复用 `runtime.thinking-level` 全局配置：子 Agent 借用指挥官 LLM 推理时（`roll ask` / `roll run` / `roll chat`），reasoning/thinking effort 使用同一档位映射。

- `resolveLLMCall` 对 `sampling` purpose 注入与 `chat` 相同的 `thinkingProviderOptions`；`ask` / `run` 构造 sampling model 改走统一解析入口。
- `ConversationEngine` 把初始档位传给子 Agent Sampling；Ink TUI 的 `/think`、`/effort` 与快捷键切档后，主会话和已缓存 MCP 连接的后续 Sampling 请求同步更新，新接入 Agent 也使用最新档位。
- Sampling 严格保留子 Agent 请求的 MCP `maxTokens` 上限，不会为了 provider thinking budget 静默扩大答案长度。
- 行为变化：Sampling 此前不带 thinking 配置（走 provider 默认），现在默认跟随配置档位（默认 `medium`；Qwen 为 `enableThinking + 8192 thinkingBudget`）。如需关闭，设 `runtime.thinking-level: off` 或在交互会话中执行 `/think off`。
