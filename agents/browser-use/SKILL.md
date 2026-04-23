---
name: browser-use-agent
description: 浏览器操控 Agent。控制浏览器操作招聘平台——读取消息、打开聊天、发送回复、换微信、查看推荐列表、打招呼、查看简历。
metadata:
  roll-env-file: references/env.yaml
---

# Browser Use Agent

浏览器自动化 Agent，作为招聘平台消息收发的执行层（"手"）。通过 Playwright 控制浏览器，提供平台级 workflow 操作。

需要先启动 Agent 服务进程（HTTP 常驻），浏览器 session 跨调用持久。

默认情况下，agent 会在可见浏览器页面内同时启用两类页内反馈：

- `BROWSER_VISUAL_CURSOR`：点击/输入前显示虚拟指针和点击波纹
- `BROWSER_VISUAL_ACTIVITY`：读取消息列表、识别账号、提取聊天详情等非点击型操作期间，显示状态胶囊、区域柔光和完成态反馈

若不需要，可分别设为 `false` 关闭。

完整 inputSchema 可通过 `roll agent tools browser-use-agent`（或 `--json`）查询。

## 通用 Tools

 - `browser_status()` — 查询浏览器运行状态和活跃 session；输出含 `replyAuthorityKeysLoaded`（启动期 Reply Authority 公钥是否预加载成功）、`visualCursorEnabled`（页内虚拟指针是否启用）、`visualActivityEnabled`（页内读操作反馈是否启用）和 `effectiveEnvSources`（声明过的 env key 的 `{present, fingerprint}`，SHA256 前 8 位，不泄漏 value）。后者被 `roll doctor` / `roll agent info` 消费，用于检测 env 声明与运行态的 drift
- `open_platform(platform)` — 通过原生 CDP 打开并聚焦招聘平台主页；登录前不会触发 Playwright attach
- `list_pages(platform?)` — 通过原生 CDP 列出当前浏览器中可见的页面和 pageId（登录前 `pageId` 即原生 targetId）
- `select_page(platform, pageId)` — 将指定页面绑定为平台当前活跃页；登录前优先走原生 CDP target 激活
- `navigate_active_tab(url)` — 导航到指定 URL；若 URL 属于 `zhipin/yupao`，优先复用已打开的平台页，避免把无关 tab 导航成第二个平台页

## 调试 Tools

- `attach_browser_session()` — 调试工具。显式执行一次 `connectOverCDP()`，用于隔离验证“仅 attach”是否会触发站点风控

## BOSS直聘 — 聊天 Tools

- `zhipin_read_messages(limit?, onlyUnread?, sortBy?)` — 读取消息列表中的候选人，默认返回全部消息；若只看未读，显式传 `onlyUnread=true`
- `zhipin_open_chat_page()` — 通过点击 Boss 左侧导航切换回「沟通」页；优先复用当前已登录的 Boss 页面，不让编排器去猜站内 URL
- `zhipin_open_chat(conversationId?, candidateName?, index?, preferUnread?)` — 打开指定候选人的聊天窗口；匹配优先级是 `conversationId` > `candidateName` > `index`
- `zhipin_get_candidate_info(conversationId?, candidateName?, index?, maxMessages?)` — 提取候选人资料、聊天记录，以及当前选中聊天的 `conversationId` / `candidateId`。输出里的 `candidateInfo.communicationPosition`、`candidateInfo.expectedLocation`、`candidateInfo.expectedPosition` 已按“沟通职位 + 最近关注”结构化解析；若 `communicationPosition` 含连字符类分隔符（`-` / `－` / `—` / `–`），则取第一段作为可选 `preferredBrand`，否则不输出该字段
- `zhipin_send_reply(signedEnvelope, candidateName?, index?)` — 发送消息。只接受 Reply Authority Service 签发的 `signedEnvelope`；本地会先做 Ed25519 验签、过期检查、重放检查、目标绑定校验和 recruiter 绑定校验。启动期公钥预加载失败时直接前置拒绝，错误指向 `browser_status.replyAuthorityKeysLoaded`
- `zhipin_exchange_wechat(conversationId?, candidateName?, index?)` — 换微信。若已知 `conversationId`，优先传它；`candidateName/index` 只作兜底
- `zhipin_get_username()` — 获取当前登录的招聘者用户名，返回 `username`（依赖当前 runtime 已跟踪页面；首次使用请先 `open_platform`，已打开但未跟踪页面可先 `list_pages + select_page`，确认登录后如需单独验证 attach，可先调用 `attach_browser_session`）。常用于 recruiter binding 解析和外部通知消息中的账号标识

## BOSS直聘 — 聊天编排硬规则

聊天工具链必须把 `conversationId` / `candidateId` 当作稳定主键，而不是把左侧列表的瞬时 `index` 当主键。

原因：

- BOSS 左侧消息列表是虚拟列表，DOM 只保留当前窗口内的若干条记录
- 点击会话、发送消息、收到新消息后，列表会实时重排
- 同一个人上一轮是 `index=3`，下一轮可能已经变成 `index=0`
- 因此 `index` 只适合“当前这一轮、当前这个 DOM 快照内”的临时兜底，不适合跨 tool / 跨 agent 透传

编排要求：

1. 先调用 `zhipin_read_messages`
2. 一旦返回了 `conversationId` / `candidateId`，后续所有 related tool 都复用这两个值
3. 调 `zhipin_open_chat` / `zhipin_get_candidate_info` / `zhipin_exchange_wechat` 时，优先传 `conversationId`
4. 调 `smart-reply-agent.generate_reply(..., target)` 时，`target.conversationId` / `target.candidateId` 必须直接来自 `browser-use-agent` 的真实输出
5. 禁止把 `zhipin_read_messages` 返回数组里的 `index` 缓存到下一轮，再把它当作会话主键使用
6. 只有在当前轮次拿不到 `conversationId` 时，才允许临时退回 `candidateName` 或 `index`

错误做法：

- `zhipin_read_messages` 拿到 `index=2`，几轮之后再调用 `zhipin_open_chat(index=2)`
- 用 `candidateName` 重新模糊匹配一个会话，再把历史 `candidateId` 假定为同一个人
- `smart-reply-agent` 的 `target` 不用 `browser-use-agent` 返回的 `conversationId/candidateId`，而是由 orch 自己重建

推荐做法：

1. `zhipin_read_messages` → 记录 `conversationId + candidateId + candidateName`
2. `zhipin_open_chat(conversationId)`
3. `zhipin_get_candidate_info(conversationId)`
4. `smart-reply-agent.generate_reply(..., target={ platform, conversationId, candidateId, recruiterUsername|recruiterBinding })`
5. `zhipin_send_reply(signedEnvelope)`

## BOSS直聘 — 推荐列表 Tools

- `zhipin_open_recommend_page()` — 通过点击 Boss 左侧导航切换到「推荐牛人」页；优先复用当前已登录的 Boss 页面，不让编排器去猜站内 URL
- `zhipin_get_candidate_list(maxResults?)` — 获取推荐列表页的候选人卡片信息（姓名、年龄、学历、期望薪资等）
- `zhipin_say_hello(indices)` — 对推荐列表中的候选人批量点击「打招呼」
- `zhipin_open_resume(index)` — 点击候选人卡片打开简历详情弹窗
- `zhipin_locate_resume_canvas()` — 定位简历弹窗中嵌套 iframe 内的 canvas 坐标（用于截图）
- `zhipin_close_resume()` — 关闭简历详情弹窗

## 鱼泡 Tools

- `yupao_read_messages(limit?)` — 读取鱼泡未读消息列表
- `yupao_send_reply(conversationId, message)` — 向鱼泡指定对话发送回复

## 典型工作流

1. `zhipin_read_messages` → 获取消息列表，并记录 `conversationId` / `candidateId`
2. `zhipin_open_chat_page()` → 通过左侧导航切回 `沟通`（需要时）
3. `zhipin_open_chat(conversationId)` → 按稳定会话 ID 打开聊天
4. `zhipin_get_candidate_info(conversationId)` → 查看候选人资料、聊天记录
5. 调 `smart-reply-agent.generate_reply` 前，先尝试透传以下信号：
   - 能读到就传：`candidateInfo.communicationPosition`、`candidateInfo.expectedLocation`、`candidateInfo.expectedPosition`
   - 读不到就如实不传
   - `preferredBrand`：仅当 `communicationPosition` 含连字符类分隔符（`-` / `－` / `—` / `–`）时，取第一段透传；没有分隔符就不传
   - 严禁把通用岗位名（如“餐饮兼职服务员”“门店服务员”）或 `zhipin_get_candidate_list.company`（候选人现/前雇主）伪装成 `preferredBrand`
6. `smart-reply-agent.generate_reply(..., target)` → 获取 `suggestedReply + signedEnvelope`
7. `zhipin_send_reply(signedEnvelope)` → 验签、校验 recruiterBinding 后发送回复
8. `zhipin_exchange_wechat` → 交换微信（可选）

推荐列表链路建议：

1. `zhipin_open_recommend_page()` → 通过左侧导航切到 `推荐牛人`
2. `zhipin_get_candidate_list(maxResults?)` → 读取候选人卡片
3. `zhipin_say_hello(indices)` → 批量打招呼

## 支持平台

- BOSS直聘 (zhipin)
- 鱼泡 (yupao)

## Reply Authority 集成说明

- `zhipin_send_reply` 不再接受裸文本 `message`
- 实际发送文本来自验签后的 envelope payload 内部 `reply` 字段
- envelope 绑定 `conversationId + candidateId + recruiterBinding`，若当前选中聊天或当前登录招聘者与签名目标不一致，会拒绝发送
- Agent 启动时会尝试从 `REPLY_AUTHORITY_KEYS_URL` 预拉公钥；若拉取失败：
  - `runtime-holder` 写入 `replyAuthorityKeysLoaded=false`，`browser_status` 输出该字段
  - `zhipin_send_reply` 在验签前直接前置拒绝并返回结构化错误，不再走到 verify 才失败
  - 其他只读工具仍可用，排障时优先 `roll run browser-use-agent browser_status --json` 或 `roll doctor --json`
