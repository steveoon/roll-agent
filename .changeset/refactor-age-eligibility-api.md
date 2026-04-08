---
"@roll-agent/smart-reply-agent": minor
---

refactor: 重构 `age-eligibility` 为 source chain + 纯评估器

Breaking change:
- `evaluateAgeEligibility()` 不再读取 `process.env` 或直接请求 Duliday API
- `evaluateAgeEligibility()` 改为同步纯评估函数，输入从旧的
  `{ age, brandAlias, cityName, regionName, strategy }`
  变为
  `{ age, evidence, matchedCount?, total?, isComplete?, strategy }`
- 如需默认取证链，请改用
  `createDefaultAgeEligibilitySources()` + `collectAgeEvidenceFromSources()`

兼容行为：
- `generateSmartReply()` 未传 `ageEligibilitySources` 时，默认优先使用 `configData`
- 仅当 `DULIDAY_TOKEN` 与 `DULIDAY_JOB_LIST_URL` 都存在时，才追加 Duliday API fallback
- `summary.matchedCount/total` 保留为“过滤后命中数 / source 总数”语义
