---
"@roll-agent/browser-use-agent": patch
---

feat(browser-use): add semantic navigation tools, visual activity system, and stable conversation IDs

- 新增 `navigate_active_tab`、`zhipin_open_chat_page`、`zhipin_open_recommend_page` 三个语义导航 tool，替代硬编码 URL 跳转
- 引入 visual activity session 系统：cursor 生命周期与 activity tone 独立管理，支持从 theme key 派生色调
- `browser_status` tool 重构视觉反馈输出，cursor 显示与活动状态解耦
- BOSS 聊天工作流（read-messages、send-reply、open-chat、exchange-wechat 等）引入稳定 conversation ID，确保跨调用会话一致性
