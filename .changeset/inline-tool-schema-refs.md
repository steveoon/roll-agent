---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

MCP 工具 schema 的本地 `$ref` 在消费边界统一内联，修复 Gemini 报「only supports references to direct children of root-level $defs」以及 preflight / `roll ask` 提参对 `$ref` 字段静默放行、丢类型的问题

- `normalizeListedTools()`（chat / ask / run 共用）把非递归本地引用内联成语义等价的完整 schema：只遍历承载子 schema 的标准关键字，`const` / `enum` / `default` / `examples` 与扩展字段中的 ref-shaped 数据保持不透明；只合并注解型及 `$defs` / `definitions` 容器兄弟键，`$ref` 旁带校验关键字时不内联；递归、外部、目标不存在、带校验兄弟键、展开超限的引用保留原样并告警，挂在 `AgentTool.schemaIssues`；限额只针对引用展开，无 `$ref` 的 schema 不受影响
- 会话层按 provider 判断残留引用能否接受（google 只接受根级 `#/$defs/<名>` 的递归引用，其余 provider 直接透传），不可接受的工具对模型不可见并告警；该判断在建会话、`/model` 切换 provider、会话中动态安装 Agent 三处统一重算
- `buildAgentToolset()` 对直接构造的 `AgentToolSource` 做幂等防御内联，并保留 `schemaIssues` 供策略使用
- `roll agent tools --json` 现在输出内联后的 schema（即模型与 preflight 实际看到的版本），不再原样透出 wire schema 里的 `$ref`
- 新增公开 API：core `tool-runtime/json-schema-refs`（`inlineAcyclicLocalJsonSchemaReferences()`、`isRootDefinitionReference()`、`JSON_SCHEMA_REF_ISSUE_REASONS`）、`AgentTool.schemaIssues`、`normalizeListedTools(tools, { onSchemaIssue })` 与 `formatToolSchemaIssue()`、`providerAcceptsToolSchemaIssues()`；runtime `AgentSessionOptions.toolSchemaPolicy` / `onToolExcluded`、`SessionModelSwitch.toolSchemaPolicy`、`BuiltToolset.schemaIssuesByToolId`，以及导出的 `ToolSchemaPolicy`、`SessionToolExclusion` 类型
