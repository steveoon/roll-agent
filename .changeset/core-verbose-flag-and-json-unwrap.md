---
"@roll-agent/core": patch
---

feat(core/cli): add --verbose flag and improve --json output

- `roll run` 和 `roll ask` 新增 `--verbose` / `-v` 选项，启用后将调用参数输出到 debug 日志；默认 info 级别仅显示 agent.tool 名称
- 敏感参数（signedEnvelope、token、secret、password、cookie、authorization、api-key）在 debug 日志中自动脱敏为 `[redacted,len=N]`
- `roll run --json` 输出优化：MCP tool 返回单条 text block 且内容为合法 JSON 时，自动解包为对象而非嵌套的 MCP result 结构
