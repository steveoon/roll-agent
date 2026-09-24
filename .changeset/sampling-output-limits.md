---
"@roll-agent/sdk": minor
---

Allow `ctx.llm.generateText(prompt, { maxOutputTokens })` to request a validated MCP Sampling output limit between 1 and 8192 tokens. Existing calls retain the 1024-token default and `Promise<string>` result. Reject responses explicitly marked as truncated instead of returning partial text to tool callers.
