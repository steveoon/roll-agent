---
"@roll-agent/smart-reply-agent": minor
---

refactor: 重构岗位数据同步，消除捏造兜底，透传接口原值

Position Schema breaking change:
- 删除 scheduleType/urgent/attendancePolicy/schedulingFlexibility/requirements 5 个推断字段
- 新增 jobCategory/laborForm/employmentForm/trainingRequired/probationRequired/
  perMonthMinWorkTime/perMonthMinWorkTimeUnit/sourceJobName 等接口直出字段
- Benefits 改为直接透传接口原值，不再做语义判断
- HiringRequirements 扩展 languages/certificatesRaw/recruitmentRemark
- salary.base/memo 改为 nullable，context-builder 使用 salary.unit 替代硬编码单位
- combinedArrangement 解析兼容小写驼峰字符串时间格式

变更后需重新执行 sync_brand_data 同步岗位数据。
