---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

在 OpenAI Responses 与 ChatGPT 订阅模型适配入口中将未显式声明 `strict` 的 function 工具默认设为 `strict: false`，保留显式 `true`/`false`、provider 工具与既有 `roll` 命名空间行为，避免服务端隐式 strict 归一化把可选工具参数收紧为必填；同时增强 `roll__transcript` 的最小分页/分块调用说明与互斥参数冲突时的省略字段恢复指引。
