---
"@roll-agent/browser-use-agent": patch
---

feat(browser-use): replace brand whitelist with hyphen-format preferredBrand extraction

- `zhipin_get_candidate_info` 现在通过连字符类分隔符（`-` / `－` / `—` / `–`）从 `communicationPosition` 提取 `preferredBrand`，不再依赖硬编码白名单
- 提取结果作为可选字段透传给 `generate_reply`，供 smart-reply-agent 做品牌锁定
- 新增 `resolvePreferredBrand()` / `resolveExpectedSignals()` 纯函数，`resolveConversationSignals()` 统一出口
- 移除 `BRAND_ALIAS_TO_NAME` 白名单和空格兼容分隔符逻辑
