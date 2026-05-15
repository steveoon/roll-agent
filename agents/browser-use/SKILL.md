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
- 通过 Roll 调用本 Agent 时，先用 `roll skills get browser-use-agent --include-references --json` 读取当前说明和 `references/*`，再用 `roll agent tools browser-use-agent --json` 读取真实 schema。
- 完整 `inputSchema` 以 `roll agent tools browser-use-agent --json` 为准。
- `REPLY_AUTHORITY_URL` / `REPLY_AUTHORITY_BEARER_TOKEN` 是生成智能回复预览的必填环境变量；`REPLY_AUTHORITY_KEYS_URL` 是发送预备回复前验签的必填环境变量。`roll doctor` 会通过 `references/env.yaml` 和 `browser_status.effectiveEnvSources` 检查它们是否声明并在运行态生效。
- `BROWSER_SECURITY_JSON` 可选配置浏览器硬安全策略；`browser_status.security` 会返回实际加载后的 `domainAllowlist`、`maxPageContentBytes`、`maxSnapshotNodes` 和 `actionPolicy`。Boss 日常编排建议使用 `actionPolicy:"log"`，`confirm/deny` 只作为高级调试模式。
- `BROWSER_USE_POLICY_JSON` 可选配置 browser-use 工具级业务策略；日常推荐只把 `zhipin_send_prepared_reply` 配为 `confirm`。
- 长任务前或状态异常时先跑 `roll doctor --fix-plan --json`；仅对配置迁移、`agents.dataDir`、孤儿 runtime 元数据这类安全项才使用 `roll doctor --fix --json`。
- 页内反馈默认开启：
  - `BROWSER_VISUAL_CURSOR`：native CDP 点击/拖拽/滚动前显示同源虚拟鼠标轨迹和点击波纹；简历弹窗等 Playwright-backed 工具仍使用旧虚拟指针。
  - `BROWSER_VISUAL_ACTIVITY`：读取、识别、提取等操作显示状态胶囊和区域高亮。
- 需要关闭反馈时，将对应环境变量设为 `false`。

## 通用 Tools

| Tool | 用途 |
| --- | --- |
| `browser_status()` | 查询浏览器 runtime、session、Reply Authority 公钥预加载状态、视觉反馈开关、安全策略和 env 指纹。 |
| `open_platform(platform)` | 通过 native CDP 打开并聚焦招聘平台主页；登录前不触发 Playwright attach。 |
| `list_pages(platform?)` | 通过 native CDP 列出浏览器页面和 `pageId`。 |
| `select_page(platform, pageId)` | 将指定页面绑定为平台活跃页；登录前优先走 native target 激活。 |
| `navigate_active_tab(url)` | 通过 native CDP 打开/导航页面；不触发 Playwright attach，不支持直接跳转 BOSS `/web/chat/*` 后台路径。 |

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
| `zhipin_generate_reply_preview(conversationId?, candidateName?, index?, maxMessages?, reasoning?)` | native CDP | 读取聊天上下文，调用 Reply Authority SSE 流式生成回复，并在浏览器内展示阶段与临时草稿；可用 `reasoning` 控制是否请求 thinking/reasoning；返回 `preparedReplyId`，不返回 `signedEnvelope`。 |
| `zhipin_send_prepared_reply(preparedReplyId, toolActionApproval?, browserActionApproval?)` | native CDP | 发送 `zhipin_generate_reply_preview` 生成的预备回复；内部取回并验签 envelope；若 `BROWSER_USE_POLICY_JSON.tools.zhipin_send_prepared_reply.policy="confirm"`，首次调用返回 `needs_confirmation`，确认后带 `toolActionApproval` 重试；若同时启用 `BROWSER_SECURITY_JSON.actionPolicy="confirm"`，还需按返回的 `browserActionApproval` 再次重试。 |
| `zhipin_exchange_wechat(conversationId?, candidateName?, index?)` | native CDP | 点击「换微信」和确认弹窗，优先按 `conversationId` 定位聊天。 |
| `zhipin_get_username()` | native CDP | 读取当前登录招聘者用户名；用于 `recruiterUsername` / `recruiterBinding` 链路。 |

失败策略：native backend 不可用时返回 `success:false`，不自动 fallback 到 Playwright。

## BOSS直聘推荐 Tools

| Tool | Backend | 说明 |
| --- | --- | --- |
| `zhipin_open_recommend_page()` | native CDP | 点击左侧导航切到「推荐牛人」。 |
| `zhipin_list_recommend_jobs()` | native CDP | 只读推荐页顶部招聘岗位下拉；返回 `jobs[].jobRef` / `jobs[].value` / `current` / `canSwitch`，不切换岗位。 |
| `zhipin_select_recommend_job(jobRef?, jobValue?, jobName?, index?, searchKeyword?, useSearch?, forceClick?)` | native CDP | 切换推荐页顶部招聘岗位筛选；优先传 `jobRef`，其次 `jobValue`，再次 `jobName`，`index` 只作当前下拉快照兜底；`forceClick:true` 时目标已选中也会点击一次岗位项。 |
| `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)` | native CDP | 只设置年龄、性别、活跃度；未传维度重置为 `不限`，年龄默认 `16-不限`；若返回 `status:"requires_vip"`，表示当前账号无法使用该筛选。 |
| `zhipin_get_candidate_list(maxResults?, autoScroll?, maxScrolls?)` | native CDP | 读取推荐候选人卡片；默认滚动并按 `candidateId` / `data-geek` 去重，返回 `candidateRef`。 |
| `zhipin_say_hello(indices?, candidateRefs?)` | native CDP | 批量点击「打招呼」；优先传 `candidateRefs`，`indices` 只作当前 DOM 快照兜底。 |
| `zhipin_open_resume(index?, candidateRef?)` | Playwright-backed | 打开简历弹窗；优先传 `candidateRef`，低优先级未迁移项。 |
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
4. 生成聊天回复优先调用 `zhipin_generate_reply_preview(conversationId)`；它会打开目标聊天、在浏览器内展示 Reply Authority SSE 的阶段、工具执行状态和临时草稿，不需要先额外调用 `zhipin_open_chat`。
5. `draft.delta` 只能展示，不能发送；真正可发送内容只来自 Reply Authority `final` 事件生成的内部签名结果。
6. 发送回复只能调用 `zhipin_send_prepared_reply(preparedReplyId, toolActionApproval?, browserActionApproval?)`；主输入只能使用 `preparedReplyId`，确认重试时可原样带回 `needs_confirmation` 返回的 approval；不要构造裸文本发送路径，也不要保存或传递 `signedEnvelope`。
7. `zhipin_send_prepared_reply` 会校验 envelope 的 `conversationId + candidateId + recruiterBinding`，当前页面目标或招聘者不一致时拒绝。
8. 需要更强推理时，可给 `zhipin_generate_reply_preview` 传 `reasoning:{enabled:true, effort:"low"|"medium"|"high", scope:"reply"|"all"}`；不传则沿用 Reply Authority Service 默认策略。
9. `preferredBrand` 只来自 `zhipin_get_candidate_info` 对 `communicationPosition` 的连字符格式解析；不要用通用岗位名或候选人公司名伪造。
10. 推荐页岗位筛选优先调用 `zhipin_list_recommend_jobs()`；若返回 `canSwitch:false`，说明当前账号/页面没有可切换目标，不要继续盲试岗位名。
11. `jobRef` 来自 `zhipin_list_recommend_jobs` 输出，格式如 `@j1`；选择岗位时优先传 `zhipin_select_recommend_job({ jobRef })`。
12. `jobRef` 只对最近一次岗位下拉快照有意义；筛选、搜索、刷新或页面重开后先重新调用 `zhipin_list_recommend_jobs`。
13. 推荐页岗位筛选的稳定主键是 `zhipin_list_recommend_jobs` / `zhipin_select_recommend_job` 返回的 `value`；已知 `value` 时传 `jobValue`。
14. 推荐岗位只知道标题时传 `jobName`；`index` 只表示当前岗位下拉快照，不要在搜索、筛选、刷新或跨步骤后复用。
15. `zhipin_select_recommend_job` 返回 `status:"selected"` 或 `status:"already_selected"` 都表示目标岗位已生效。
16. `zhipin_select_recommend_job` 返回 `status:"not_found"` 时不要盲目重试；先调用 `zhipin_list_recommend_jobs`，再选择最接近岗位的 `jobRef` 或 `value`。
17. 只有明确需要重新点击已选中岗位项时才传 `forceClick:true`；默认不要传，避免无意义重复点击。
18. `zhipin_filter_recommend_candidates` 返回 `status:"requires_vip"` 时不要反复尝试绕过筛选 UI；当前账号没有权限使用该筛选，改为直接读取当前推荐列表或调整业务策略。
19. 聊天消息列表不产生 `candidateRef`；聊天回复链路使用 `conversationId` / `candidateId`，推荐候选人链路才使用 `candidateRef`。
20. 推荐候选人列表的 `candidateRef` 来自 `zhipin_get_candidate_list` 输出，格式如 `@c1`；后续 `zhipin_say_hello` / `zhipin_open_resume` 优先传它。
21. `candidateRef` 只对最近一次推荐列表快照有意义；筛选、搜索、滚动加载、刷新或页面重开后先重新调用 `zhipin_get_candidate_list`。
22. 不要自行构造 `jobRef` / `candidateRef`；只能传本 Agent 刚返回的 ref。
23. 调 `zhipin_say_hello` 前，先从 `zhipin_get_candidate_list` 结果中过滤 `buttonText:"打招呼"` 的候选人；`buttonText` 为空通常表示已经打过招呼。
24. 如果业务有年龄、资格或岗位匹配约束，必须先按 `age` / `expectedPosition` / `tags` 等列表字段过滤；不要把刚读到的全部 `candidateRefs` 盲目提交。
25. `zhipin_say_hello({ candidateRefs })` 支持同一快照内连续提交多个 ref；若返回“候选人引用已过期”，说明 BOSS 列表已重排，重新执行 `zhipin_get_candidate_list` 后只重试剩余目标。
26. 高频连续 tool call 可用 `roll run --batch-stdin --json` 批量提交，但每项仍要显式声明 `agent` / `tool` / `input`，不要假设 batch 自动传递上一步输出。
27. 不要用 `navigate_active_tab` 直接跳转 `https://www.zhipin.com/web/chat/*`；聊天页用 `zhipin_open_chat_page()`，推荐页用 `zhipin_open_recommend_page()`。

## 典型链路

```text
聊天回复:
zhipin_read_messages
  -> zhipin_generate_reply_preview(conversationId)
  -> zhipin_send_prepared_reply(preparedReplyId)

推荐候选人:
zhipin_open_recommend_page
  -> zhipin_list_recommend_jobs()
  -> zhipin_select_recommend_job(jobRef | jobValue | jobName)  # 可选；canSwitch=false 时跳过
  -> zhipin_filter_recommend_candidates(...)  # 可选；requires_vip 时跳过筛选
  -> zhipin_get_candidate_list(maxResults?, autoScroll=true)
  -> 按 buttonText/年龄/业务资格过滤
  -> zhipin_say_hello(candidateRefs)
```

## 参考资料

- `references/zhipin-diagnostics.md`：BOSS native CDP / attach 诊断阶段、推进顺序和返回字段。
- `references/zhipin-workflows.md`：聊天主键、动态列表、`preferredBrand`、Reply Authority 编排细节。
- `references/env.yaml`：运行所需环境变量声明。
