---
"@roll-agent/core": minor
---

新增 Google Gemini LLM provider（`google`）

- `llm.default-provider: google` 即可使用 Gemini，API key 走 `llm.providers.google.api-key`（`roll setup` / `roll config init` 默认引用 `GOOGLE_GENERATIVE_AI_API_KEY`），支持 `base-url` 自定义端点；默认模型 `gemini-3.8-flash`
- thinking-level 映射：Gemini 3 及以上按 `thinkingLevel`（low/medium/high）下发并开启 `includeThoughts` 以在 chat 中显示思考摘要，`off` 退到该模型允许的最低档（3.7+ Flash 与 `gemini-flash-latest` 为 `low`，其余为 `minimal`）；Gemini 2.5 按 `thinkingBudget`（2048/8192/16384）下发，`off` 为 0，`gemini-2.5-pro` 不可关闭思考故退到最低预算 128
- structured output（`roll ask` 提参、compaction）沿用 AI SDK 统一 `reasoning` 语义；`gemini-2.5-pro` 在 `thinking-level: off` 下会像 OpenAI/xAI 一样直接报错提示改为 low 及以上
- 依赖新增 `@ai-sdk/google` 4.0.54
