---
"@roll-agent/core": minor
---

MCP Sampling 复用 `runtime.thinking-level` 全局配置：子 Agent 借用指挥官 LLM 推理时（`roll ask` / `roll run`），reasoning/thinking effort 跟随 `roll chat` 的同一档位映射。

- `resolveLLMCall` 对 `sampling` purpose 注入与 `chat` 相同的 thinkingProviderOptions；`ask`/`run` 构造 sampling model 改走 `resolveLLMCall`。
- `registerSamplingHandler` 新增可选 `providerOptions` 参数（未传时行为与现状一致，对既有调用点零影响）；`generateText` 参数组装抽为纯函数 `buildSamplingGenerateTextParams` 并补单测。
- 行为变化：sampling 此前不带任何 thinking 配置（走 provider 默认），现在默认跟随配置档位（默认 `medium`，qwen 上即 enableThinking + 8192 thinking budget）。如需关闭，设 `runtime.thinking-level: off`。
