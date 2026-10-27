---
"@roll-agent/runtime": patch
---

修复 Zod 4 升级后 OpenAI 拒绝定时任务、交互表单及 MCP 工具中的判别联合 schema，导致普通聊天请求也无法执行的问题。仅将具有互斥必填判别字段的 `oneOf` 转换为等价 `anyOf`，保留原始参数校验、转换与工具执行契约。
