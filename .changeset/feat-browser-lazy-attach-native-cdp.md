---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": minor
---

feat(browser): lazy Playwright attach + 原生 CDP 页面管理

解决 Boss 直聘反自动化检测问题。根因：Playwright 在登录前持续 attach 整个浏览器 + newPage/goto 开页被 Boss 风控识别为自动化行为。

**@roll-agent/browser 改动：**
- BrowserRuntime 启动后不再立即 connectOverCDP()，改为首次 getBrowser() 时 lazy attach
- 新增 NativeCdpPageClient，通过原生 CDP HTTP 接口（/json/list、/json/new、/json/activate）管理页面，全程不触发 Playwright
- ContextManager 支持双轨状态：登录前 nativeSelection + 登录后 Playwright Page，attach 时启发式匹配回之前选中的 tab
- 新增 profile 装饰（名称/颜色/clean exit 标记），Chrome 启动参数对齐 OpenClaw
- DI 模式支持测试注入 spawn/connectOverCDP/fetch

**@roll-agent/browser-use-agent 改动：**
- open_platform / list_pages / select_page 全部切到原生 CDP 路径，登录前零 Playwright attach
- 新增 attach_browser_session 调试工具，显式触发 connectOverCDP
- 聊天页进入策略重构为四级 fallback：已是聊天页 → 复用已有聊天 tab → UI 点击消息按钮 → goto 兜底（软失败）
- 所有 zhipin_* 工具内联的 page.goto 已清除，统一到 chat-navigation 辅助函数
