---
"@roll-agent/smart-reply-agent": patch
---

SKILL.md 适配沟通职位品牌 ID 尾缀规范：`generate_reply` 签名补充 `preferredBrandId?`；编排约束改为只原样透传 `zhipin_get_candidate_info` 输出的品牌字段（新命名给 `preferredBrandId`、老命名给 `preferredBrand`，互斥），禁止编排器自行解析 `communicationPosition`。
