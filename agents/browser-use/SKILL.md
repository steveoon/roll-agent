---
name: browser-use-agent
description: 浏览器操控 Agent。控制浏览器操作招聘平台：读取消息、打开聊天、发送签名回复、换微信、滚动动态列表、查看推荐列表、筛选候选人、打招呼、查看简历，并提供 BOSS直聘 native CDP / Playwright attach 风控诊断。
metadata:
  roll-env-file: references/env.yaml
---

# Browser Use Agent

浏览器自动化执行层。BOSS 直聘主链路优先走 native CDP backend；未迁移的低优先级简历弹窗工具仍使用 Playwright-backed 页面 attach。

## 使用前提

- 先启动 `browser-use-agent` HTTP 常驻服务；浏览器 session 跨调用持久。
- 完整 `inputSchema` 以 `roll agent tools browser-use-agent --json` 为准。
- `REPLY_AUTHORITY_KEYS_URL` 是必填环境变量；`roll doctor` 会通过 `references/env.yaml` 和 `browser_status.effectiveEnvSources` 检查它是否声明并在运行态生效。
- 页内反馈默认开启：
  - `BROWSER_VISUAL_CURSOR`：native CDP 点击/拖拽/滚动前显示同源虚拟鼠标轨迹和点击波纹；简历弹窗等 Playwright-backed 工具仍使用旧虚拟指针。
  - `BROWSER_VISUAL_ACTIVITY`：读取、识别、提取等操作显示状态胶囊和区域高亮。
- 需要关闭反馈时，将对应环境变量设为 `false`。

## 招聘事件埋点

`browser-use-agent` 可在 zhipin 工具成功路径异步写入招聘事件 Open API。当前只支持**单 browser-use 实例 / 单 Boss 账号**口径，多浏览器实例 / 多 Boss 账号归因设计见 GitHub issue #77。

| 事件 | 触发工具 | 触发时机 |
| --- | --- | --- |
| `message_received` | `zhipin_read_messages` | 返回候选人 `hasUnread=true` 且存在稳定职位口径时 |
| `message_sent` | `zhipin_send_reply` | Reply Authority envelope 验签、目标校验、消息发送成功后 |
| `candidate_contacted` | `zhipin_say_hello` | 推荐卡片「打招呼」点击成功后 |
| `wechat_exchanged` | `zhipin_exchange_wechat` / `zhipin_get_candidate_info` | 主动换微信成功，或聊天详情检测到微信交换卡片 |

配置口径：

| 环境变量 | 说明 |
| --- | --- |
| `RECRUITMENT_EVENTS_DEFAULT_AGENT_ID` | 必填；当前单实例绑定的招聘业务 `agentId`，用于事件归因 |
| `RECRUITMENT_EVENTS_API_TOKEN` | 必填；Open API Bearer token，公开 npm 包不内置兜底 token |
| `RECRUITMENT_EVENTS_ENABLED` | 可选；未设置时默认启用，设为 `false` 可关闭 |
| `RECRUITMENT_EVENTS_API_BASE_URL` | 可选；默认走 `https://huajune.duliday.com`，实际调用 `/api/v1/recruitment-events` |

检查边界：

- `RECRUITMENT_EVENTS_DEFAULT_AGENT_ID`、`RECRUITMENT_EVENTS_API_TOKEN` 在 `references/env.yaml` 中声明为 required，`roll agent info` / `roll doctor` 会检查它们。
- `RECRUITMENT_EVENTS_ENABLED`、`RECRUITMENT_EVENTS_API_BASE_URL` 在 `references/env.yaml` 中声明为 optional，并带默认值说明。
- `browser_status.effectiveEnvSources` 会暴露这些变量的运行态指纹，`doctor` 可发现已配置但运行态不同的漂移。
- 如果 `RECRUITMENT_EVENTS_API_TOKEN` 或 `RECRUITMENT_EVENTS_DEFAULT_AGENT_ID` 缺失，工具成功路径只输出一次 `warn` 并跳过上报。
- 当前 `doctor` 不能表达“`RECRUITMENT_EVENTS_ENABLED=false` 时不要求 token / `agentId`”的条件规则；关闭埋点但不配必填项仍会被静态声明检查提示。
- 埋点 API 请求失败不影响工具返回结果，只写入 agent 日志。

## 通用 Tools

| Tool | 用途 |
| --- | --- |
| `browser_status()` | 查询浏览器 runtime、session、Reply Authority 公钥预加载状态、视觉反馈开关和 env 指纹。 |
| `open_platform(platform)` | 通过 native CDP 打开并聚焦招聘平台主页；登录前不触发 Playwright attach。 |
| `list_pages(platform?)` | 通过 native CDP 列出浏览器页面和 `pageId`。 |
| `select_page(platform, pageId)` | 将指定页面绑定为平台活跃页；登录前优先走 native target 激活。 |
| `navigate_active_tab(url)` | 导航当前平台页；对 `zhipin` / `yupao` 优先复用已打开平台 tab。 |

## 调试 Tools

| Tool | 触发点 |
| --- | --- |
| `attach_browser_session()` | 只在调试时显式执行一次 `connectOverCDP()`，用于验证“仅 attach”是否触发风控。 |
| `zhipin_diagnose_browser_state(phase?, targetPageId?, watchMs?, networkEventLimit?)` | 分阶段定位 BOSS 页面在 native CDP、Playwright attach、evaluate、storage/cookie 读取时的回退/风控触发点。 |
| `zhipin_scroll_view(surface, direction?, steps?, distance?, settleMs?)` | native CDP 滚动或检查 `chat-list`、`chat-history`、`recommend-list` 内部动态列表；`steps=0` 只返回 `atTop` / `atBottom` / `canScrollUp` / `canScrollDown` / `position`。 |

诊断细节见 `references/zhipin-diagnostics.md`。正常业务路径不要默认调用 `zhipin_diagnose_browser_state()`。

常见诊断 phase 关键词：`native`、`native-watch`、`native-ws-connect`、`native-page-bring-front`、`native-evaluate-url-no-runtime-enable`、`native-dom-read-no-runtime-enable`、`native-input-move-no-runtime-enable`、`native-runtime-enable`、`browser-attach`、`page-attach`、`network-watch`、`page-evaluate`、`detector-fingerprint`、`storage-summary`。

## BOSS直聘聊天 Tools

| Tool | Backend | 说明 |
| --- | --- | --- |
| `zhipin_read_messages(limit?, onlyUnread?, sortBy?, autoScroll?, maxScrolls?)` | native CDP | 读取消息列表；默认 `autoScroll=true`，按 `conversationId` 去重。 |
| `zhipin_open_chat_page()` | native CDP | 点击左侧导航切回「沟通」。 |
| `zhipin_open_chat(conversationId?, candidateName?, index?, preferUnread?)` | native CDP | 打开目标聊天；匹配优先级为 `conversationId` > `candidateName` > `index`。 |
| `zhipin_get_candidate_info(conversationId?, candidateName?, index?, maxMessages?)` | native CDP | 提取候选人资料、聊天记录、`conversationId`、`candidateId` 和页面职位信号。 |
| `zhipin_send_reply(signedEnvelope, candidateName?, index?)` | native CDP | 验签 Reply Authority v2 envelope 后发送；输入路径为 native 点击编辑器、`Input.insertText`、native 点击发送。 |
| `zhipin_exchange_wechat(conversationId?, candidateName?, index?)` | native CDP | 点击「换微信」和确认弹窗，优先按 `conversationId` 定位聊天。 |
| `zhipin_get_username()` | native CDP | 读取当前登录招聘者用户名；用于 `recruiterUsername` / `recruiterBinding` 链路。 |

失败策略：native backend 不可用时返回 `success:false`，不自动 fallback 到 Playwright。

## BOSS直聘推荐 Tools

| Tool | Backend | 说明 |
| --- | --- | --- |
| `zhipin_open_recommend_page()` | native CDP | 点击左侧导航切到「推荐牛人」。 |
| `zhipin_select_recommend_job(jobValue?, jobName?, index?, searchKeyword?, useSearch?)` | native CDP | 切换推荐页顶部招聘岗位筛选；优先传 `jobValue`，其次 `jobName`，`index` 只作当前下拉快照兜底；返回 `current` / `selected` / `options`。 |
| `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)` | native CDP | 只设置年龄、性别、活跃度；未传维度重置为 `不限`，年龄默认 `16-不限`。 |
| `zhipin_get_candidate_list(maxResults?, autoScroll?, maxScrolls?)` | native CDP | 读取推荐候选人卡片；默认滚动并按 `candidateId` / `data-geek` 去重。 |
| `zhipin_say_hello(indices)` | native CDP | 按当前推荐列表 DOM `index` 批量点击「打招呼」。 |
| `zhipin_open_resume(index)` | Playwright-backed | 打开简历弹窗；低优先级未迁移项。 |
| `zhipin_locate_resume_canvas()` | Playwright-backed | 定位 `#recommendFrame -> iframe[src*="c-resume"] -> canvas#resume, div#resume canvas`。 |
| `zhipin_close_resume()` | Playwright-backed | 关闭简历弹窗；selector 契约见 `src/pages/zhipin/resume-dom-contract.ts`。 |

推荐链路和动态列表细节见 `references/zhipin-workflows.md`。

## 鱼泡 Tools

| Tool | 说明 |
| --- | --- |
| `yupao_read_messages(limit?)` | 读取鱼泡未读消息列表。 |
| `yupao_send_reply(conversationId, message)` | 向鱼泡指定对话发送回复。 |

## 编排硬规则

1. `conversationId` / `candidateId` 是聊天稳定主键；`index` 只表示当前 DOM 快照。
2. `zhipin_read_messages` 返回了 `conversationId` / `candidateId` 后，后续 related tool 必须复用这些真实输出。
3. 调 `zhipin_open_chat`、`zhipin_get_candidate_info`、`zhipin_exchange_wechat` 时优先传 `conversationId`。
4. 调 `smart-reply-agent.generate_reply(..., target)` 时，`target.conversationId` / `target.candidateId` 必须来自 `browser-use-agent` 输出。
5. 发送回复只能调用 `zhipin_send_reply(signedEnvelope)`；不要构造裸文本发送路径。
6. `zhipin_send_reply` 会校验 envelope 的 `conversationId + candidateId + recruiterBinding`，当前页面目标或招聘者不一致时拒绝。
7. `preferredBrand` 只来自 `zhipin_get_candidate_info` 对 `communicationPosition` 的连字符格式解析；不要用通用岗位名或候选人公司名伪造。
8. 推荐页岗位筛选的稳定主键是 `zhipin_select_recommend_job` 返回的 `options[].value`；已知岗位 `value` 时必须优先传 `jobValue`。
9. 推荐岗位只知道标题时传 `jobName`；`index` 只表示当前岗位下拉快照，不要在搜索、筛选、刷新或跨步骤后复用。
10. `zhipin_select_recommend_job` 返回 `status:"selected"` 或 `status:"already_selected"` 都表示目标岗位已生效。
11. `zhipin_select_recommend_job` 返回 `status:"not_found"` 时不要盲目重试；先读取返回的 `options`，选择最接近岗位并复用其 `value` 作为 `jobValue`。

## 典型链路

```text
聊天回复:
zhipin_read_messages
  -> zhipin_get_username
  -> zhipin_open_chat(conversationId)
  -> zhipin_get_candidate_info(conversationId)
  -> smart-reply-agent.generate_reply(..., target)
  -> zhipin_send_reply(signedEnvelope)

推荐候选人:
zhipin_open_recommend_page
  -> zhipin_select_recommend_job(jobValue | jobName)
  -> zhipin_filter_recommend_candidates(...)
  -> zhipin_get_candidate_list(maxResults?, autoScroll=true)
  -> zhipin_say_hello(indices)
```

## 参考资料

- `references/zhipin-diagnostics.md`：BOSS native CDP / attach 诊断阶段、推进顺序和返回字段。
- `references/zhipin-workflows.md`：聊天主键、动态列表、`preferredBrand`、Reply Authority 编排细节。
- `references/env.yaml`：运行所需环境变量声明。
