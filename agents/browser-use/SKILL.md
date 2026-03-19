---
name: browser-use-agent
description: 浏览器操控 Agent。控制浏览器登录招聘平台、读取消息、发送回复。
metadata:
  roll-transport: streamable-http
  roll-endpoint: http://localhost:3100/mcp
---

# Browser Use Agent

浏览器自动化 Agent，作为招聘平台消息收发的执行层（"手"）。通过 Playwright 控制 Chromium 浏览器，提供平台级 workflow 操作。

需要先启动 Agent 服务进程（HTTP 常驻），浏览器 session 跨调用持久。

## Tools

- `browser_status()` — 查询浏览器运行状态和活跃 session
- `list_pages(platform?)` — 列出当前浏览器中可见的页面、pageId 和绑定状态
- `open_platform(platform)` — 打开并聚焦招聘平台主页，供用户手动登录或后续站内操作
- `select_page(platform, pageId)` — 将指定页面绑定为平台当前活跃页并切到前台
- `zhipin_read_messages(limit?)` — 读取 BOSS直聘未读消息列表
- `zhipin_send_reply(conversationId, message)` — 向指定对话发送回复
- `zhipin_get_candidate_info(conversationId)` — 提取候选人资料信息

## 支持平台

- BOSS直聘 (zhipin)
- 鱼泡 (yupao)

## 前置要求

- 安装 Chromium：`npx playwright install chromium`
- 启动服务：`pnpm --filter browser-use-agent dev`
