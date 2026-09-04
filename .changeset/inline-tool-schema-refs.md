---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

MCP 工具 schema 的本地 `$ref` 在消费边界统一内联，修复 Gemini 报「only supports references to direct children of root-level $defs」以及 preflight / `roll ask` 提参对 `$ref` 字段静默放行、丢类型的问题

- `normalizeListedTools()`（chat / ask / run 共用）把非递归本地引用内联成语义等价的完整 schema；递归、外部、目标不存在、超限引用保留原样并告警，挂在 `AgentTool.schemaIssues`
- 引擎按 provider 能力（目前 google 不接受递归引用）把仍带未解析引用的工具从本会话模型工具集剔除并告警，不再让一个工具拖垮整个会话；`/model` 切换 provider 后已建会话的工具集不重算
- `buildAgentToolset()` 对直接构造的 `AgentToolSource` 做幂等防御内联
