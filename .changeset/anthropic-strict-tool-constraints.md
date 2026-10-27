---
"@roll-agent/core": patch
---

修复 Anthropic 严格工具模式拒绝定时任务 schema 中的数组数量、字符串长度和数值范围等约束，导致普通聊天请求失败的问题。仅在发送严格工具定义时将不支持的值约束移到字段描述，保留类型、必填字段和判别分支；Runtime 继续使用原始 schema 完整校验参数，其他 provider 不受影响。
