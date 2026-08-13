---
"@roll-agent/browser-use-agent": patch
---

命中 BOSS 403/验证码/安全检查页时，常规 `zhipin_*` 抛 `zhipin_access_restricted` 并硬停止，避免被 catch 成「请重试」后继续打接口
