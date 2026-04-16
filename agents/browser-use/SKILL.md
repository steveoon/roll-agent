---
name: browser-use-agent
description: 浏览器操控 Agent。控制浏览器操作招聘平台——读取消息、打开聊天、发送回复、换微信、查看推荐列表、打招呼、查看简历。
metadata:
  roll-env-file: references/env.yaml
---

# Browser Use Agent

浏览器自动化 Agent，作为招聘平台消息收发的执行层（"手"）。通过 Playwright 控制浏览器，提供平台级 workflow 操作。

需要先启动 Agent 服务进程（HTTP 常驻），浏览器 session 跨调用持久。

## 通用 Tools

- `browser_status()` — 查询浏览器运行状态和活跃 session
- `open_platform(platform)` — 通过原生 CDP 打开并聚焦招聘平台主页；登录前不会触发 Playwright attach
- `list_pages(platform?)` — 通过原生 CDP 列出当前浏览器中可见的页面和 pageId（登录前 `pageId` 即原生 targetId）
- `select_page(platform, pageId)` — 将指定页面绑定为平台当前活跃页；登录前优先走原生 CDP target 激活
- `navigate_active_tab(url)` — 将当前激活 tab 导航到指定 URL

## 调试 Tools

- `attach_browser_session()` — 调试工具。显式执行一次 `connectOverCDP()`，用于隔离验证“仅 attach”是否会触发站点风控

## BOSS直聘 — 聊天 Tools

- `zhipin_read_messages(limit?, onlyUnread?, sortBy?)` — 读取消息列表中的候选人，返回姓名、消息摘要，以及 `conversationId` / `candidateId`
- `zhipin_open_chat(candidateName?, index?, preferUnread?)` — 打开指定候选人的聊天窗口（按姓名模糊匹配或列表索引）
- `zhipin_get_candidate_info(candidateName?, index?, maxMessages?)` — 提取候选人资料、聊天记录，以及当前选中聊天的 `conversationId` / `candidateId`
- `zhipin_send_reply(signedEnvelope, candidateName?, index?)` — 发送消息。只接受 Reply Authority Service 签发的 `signedEnvelope`；本地会先做 Ed25519 验签、过期检查、重放检查和目标绑定校验
- `zhipin_exchange_wechat(candidateName?, index?)` — 换微信。指定 candidateName 会自动打开对应聊天后执行
- `zhipin_get_username()` — 获取当前登录的招聘者用户名（依赖当前 runtime 已跟踪页面；首次使用请先 `open_platform`，已打开但未跟踪页面可先 `list_pages + select_page`，确认登录后如需单独验证 attach，可先调用 `attach_browser_session`）。常用于外部通知消息中的账号标识，参见 notify-agent 的跨 Agent 工作流

## BOSS直聘 — 推荐列表 Tools

- `zhipin_get_candidate_list(maxResults?)` — 获取推荐列表页的候选人卡片信息（姓名、年龄、学历、期望薪资等）
- `zhipin_say_hello(indices)` — 对推荐列表中的候选人批量点击「打招呼」
- `zhipin_open_resume(index)` — 点击候选人卡片打开简历详情弹窗
- `zhipin_locate_resume_canvas()` — 定位简历弹窗中嵌套 iframe 内的 canvas 坐标（用于截图）
- `zhipin_close_resume()` — 关闭简历详情弹窗

## 鱼泡 Tools

- `yupao_read_messages(limit?)` — 读取鱼泡未读消息列表
- `yupao_send_reply(conversationId, message)` — 向鱼泡指定对话发送回复

## 典型工作流

1. `zhipin_read_messages` → 获取未读候选人列表
2. `zhipin_open_chat(candidateName)` → 打开某人的聊天
3. `zhipin_get_candidate_info` → 查看候选人资料、聊天记录，并拿到 `conversationId` / `candidateId`
4. `smart-reply-agent.generate_reply(..., target)` → 获取 `suggestedReply + signedEnvelope`
5. `zhipin_send_reply(signedEnvelope)` → 验签后发送回复
5. `zhipin_exchange_wechat` → 交换微信（可选）

## 支持平台

- BOSS直聘 (zhipin)
- 鱼泡 (yupao)

## Reply Authority 集成说明

- `zhipin_send_reply` 不再接受裸文本 `message`
- 实际发送文本来自验签后的 envelope payload 内部 `reply` 字段
- envelope 绑定 `conversationId + candidateId`，若当前选中聊天与签名目标不一致，会拒绝发送
- Agent 启动时会尝试从 `REPLY_AUTHORITY_KEYS_URL` 预拉公钥；若拉取失败，其他只读工具仍可用，但发送会失败关闭
