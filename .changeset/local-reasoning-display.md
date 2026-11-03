---
"@roll-agent/protocol": minor
"@roll-agent/runtime": minor
"@roll-agent/core": minor
"@roll-agent/relay-protocol": patch
---

本地 Runtime 客户端可以实时展示 OpenAI Responses、Claude Messages、Gemini Generate Content 和 Grok 4.7 Responses 的公开推理摘要。连接 Relay 时，远端客户端也可收到公开摘要。DeepSeek 和 Qwen 的思考文本只交付给轮次开始时已订阅的本地连接。显示内容被截断时，客户端会收到省略提示。旧版 session 接口不再透出思考正文或 SDK 续轮选项。模型响应格式错误时，事件日志只保存错误类别。

Grok 4.5、4.6 和 4.7 不支持关闭思考。配置 `runtime.thinking-level: off` 时，Core 会在请求前提示使用 `low` 或更高档位。
