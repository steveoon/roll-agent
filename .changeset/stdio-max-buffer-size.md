---
"@roll-agent/core": minor
---

stdio Agent 可声明单条 MCP 消息的读缓冲上限 `maxBufferSize`（字节）。

`@modelcontextprotocol/sdk` 1.30.0 起 stdio 传输默认最多缓冲 10 MiB，单条 tool 结果超过即断开连接。需要返回更大 payload 的 stdio Agent 现在可以在 `package.json#rollAgent.start.maxBufferSize` 或 SKILL.md metadata `roll-max-buffer-size` 里声明上限，roll 会原样透传给 `StdioClientTransport`。未声明时沿用 SDK 默认值；非正整数在 `roll agent add` 阶段直接报错；streamable-http 传输忽略该字段。
