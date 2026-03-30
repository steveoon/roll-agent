---
"@roll-agent/browser-use-agent": minor
---

refactor(browser-use): zhipin_get_username 从 CSS selector 改为 Playwright 语义定位

- 四策略证据收集：P1 语义角色（getByRole）+ P2 ARIA snapshot + P3 叶子文本 + P4 CSS 兜底
- 纯函数打分择优，支持位置权重（xRatio）和跨策略交叉确认
- 输出 schema 增量扩展：新增 usedStrategy/source 字段，保留 usedSelector 兼容
- 抽取 platform-page.ts 复用平台页面查找逻辑
- selectExistingZhipinPage 增加 hasContext 前置检查，消除 useExistingPage 副作用
- 修复 username 长度判断 off-by-one（< 改回 <=）
