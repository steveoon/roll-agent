---
"@roll-agent/browser-use-agent": minor
---

refactor(browser-use): zhipin_get_username 升级为语义定位优先 + CSS 兜底的混合定位

- 四策略证据收集：P1 语义角色（getByRole）+ P2 ARIA snapshot + P3 叶子文本 + P4 CSS 兜底
- 纯函数打分择优，支持位置权重（xRatio）和跨策略交叉确认
- 输出 schema 增量扩展：新增 usedStrategy/source 字段，保留 usedSelector 兼容
- 抽取 platform-page.ts 复用平台页面查找逻辑
- zhipin_get_username 现在仅复用当前 runtime 已跟踪的 BOSS直聘页面，不再对未跟踪页面做隐式扫描或副作用恢复；首次使用需先 open_platform，或通过 list_pages + select_page 恢复跟踪
- 修复 username 长度判断 off-by-one（< 改回 <=）
