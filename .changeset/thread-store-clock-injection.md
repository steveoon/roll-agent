---
"@roll-agent/runtime": patch
---

`ThreadStore` 构造函数新增可选 `{ now }` 时钟，仅用于 Runtime event / tool execution 保留策略的截止时间计算；修复一批以固定日期为 fixture 的保留策略测试随日历过期失败的问题
