---
"@roll-agent/smart-reply-agent": major
---

refactor(smart-reply): 移除本地回复管线和 sync_brand_data

generate_reply 已全切 Reply Authority Service 云端签发，本地 pipeline 不再需要。

BREAKING CHANGES:
- 移除 `sync_brand_data` tool，品牌数据同步改由 reply-authority-service admin API 负责
- 移除 `./pipeline` 公开导出（package.json#exports）
- 移除 DULIDAY_TOKEN / DULIDAY_BRAND_LIST_URL / DULIDAY_JOB_LIST_URL 环境变量需求
- 删除本地 pipeline/、ai/、errors/ 模块和 data/ 目录
- 类型层收缩为最小 schema（CandidateInfoSchema、ModelConfigSchema、FunnelStageSchema）
