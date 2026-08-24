---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
"@roll-agent/sdk": patch
---

升级 AI SDK 生态依赖到当前 7.x 线的最新 patch 版本，并同步 MCP SDK。

- `ai` ^7.0.9→^7.0.65、`@ai-sdk/provider` ^4.0.1→^4.0.7、`@ai-sdk/anthropic` ^4.0.4→^4.0.38、`@ai-sdk/openai` ^4.0.4→^4.0.41、`@ai-sdk/deepseek` ^3.0.2→^3.0.28、`@ai-sdk/alibaba` ^2.0.3→^2.0.32、`@ai-sdk/xai` 4.0.12→4.0.38
- `@modelcontextprotocol/sdk` ^1.12.0→^1.30.0（core / runtime / sdk 三包同步）
- lockfile 中 `@ai-sdk/provider` / `provider-utils` / `openai-compatible` 的重复传递版本收敛为单一版本；`zod` 保持 v3 不变
- 随依赖带来的行为变化：`@ai-sdk/anthropic` 4.0.8 起 thinking-level=off 发送的 `thinking: { type: "disabled" }` 会真正下发给 API（旧版静默丢弃）；4.0.21 起 Anthropic 的 thinking tokens 计入 `reasoningTokens` 用量；`@modelcontextprotocol/sdk` 1.30.0 起 stdio 传输单条消息默认上限 10 MiB，超限会断开连接（streamable-http 不受影响）
