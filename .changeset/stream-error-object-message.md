---
"@roll-agent/runtime": patch
---

模型流错误为非 Error 对象（provider 纯 JSON payload）时，错误信息优先取 message 字段、退回 JSON 序列化，不再渲染成 [object Object]
