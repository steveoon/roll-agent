---
name: browser-use-agent
description: 浏览器操控 Agent。控制浏览器操作招聘平台——读取消息、打开聊天、发送回复、换微信、滚动动态列表、查看推荐列表、打招呼、查看简历，并提供 BOSS直聘 CDP/页面 attach 风控触发点的分阶段诊断工具。
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
- `zhipin_diagnose_browser_state(phase?, targetPageId?, watchMs?, networkEventLimit?)` — BOSS直聘分阶段诊断工具。默认 `phase="native"`，只通过原生 CDP `/json/list` 枚举页面；`native-*` 阶段使用原生 CDP page WebSocket，不调用 Playwright/Puppeteer，并区分是否调用 `Runtime.enable`；`phase="browser-attach"` 才会执行 Playwright Browser CDP attach 并追加 `watchMs` 的原生 URL 观察窗口。用于定位“哪个阶段触发 Boss 自动回退/风控”，不用于正常招聘业务流程
- `zhipin_scroll_view(surface, direction?, steps?, distance?, settleMs?)` — 使用 native CDP backend 滚动 BOSS直聘页面内部动态列表容器，用于调试或显式翻页。`surface` 支持 `chat-list`、`chat-history`、`recommend-list`；不传 `direction` 时使用该 surface 的默认方向；失败时返回 `success:false`，不会 fallback Playwright

## BOSS直聘 — CDP/风控诊断流程

`zhipin_diagnose_browser_state` 的目标是把黑盒风控触发拆成可观测阶段。它不能替代 `zhipin_read_messages`，也不负责规避检测。

触发场景：

- 调用 `zhipin_read_messages`、`zhipin_get_username`、`zhipin_open_chat_page` 等 BOSS 工具后，页面自动 `history.goBack()` 或回到上一页
- 某个账号/某个浏览器 profile 触发，但其它账号或其它浏览器实例不触发
- 需要对比“仅 CDP 连接”、“页面绑定”、“执行 `evaluate()`”、“读取 storage/cookie”哪个阶段开始异常

不要在正常业务路径里默认调用该工具。只有出现上述异常或用户明确要求诊断时，orchestrator 才使用它。

阶段模型：

```text
低侵入分支:
  native -> native-watch

原生 CDP page WebSocket 分支:
  native -> native-ws-connect -> native-runtime-enable -> native-evaluate-url -> native-dom-read

原生 CDP no-Runtime.enable 分支:
  native -> native-ws-connect -> native-page-bring-front
  native -> native-ws-connect -> native-evaluate-url-no-runtime-enable
  native -> native-ws-connect -> native-dom-read-no-runtime-enable
  native -> native-ws-connect -> native-input-move-no-runtime-enable

attach / 网络分支:
  native -> browser-attach -> browser-attach-watch -> page-attach -> network-watch

evaluate / storage 分支:
  native -> browser-attach -> browser-attach-watch -> page-attach -> page-evaluate -> detector-fingerprint -> storage-summary
```

阶段含义：

| `phase` | 动作 | 诊断问题 |
| --- | --- | --- |
| `native` | 只调用原生 CDP `/json/list` 枚举页面 | 当前有哪些 BOSS target；最低风险默认阶段 |
| `native-watch` | 不 attach，只在 `watchMs` 内重复读取原生 target URL/title | 不连接 Playwright 时页面是否自己跳转或回退 |
| `native-ws-connect` | 连接目标页的 `webSocketDebuggerUrl`，不调用 Playwright/Puppeteer | 仅建立原生 page CDP WebSocket 是否触发 |
| `native-page-bring-front` | 连接 WebSocket 后直接发送 `Page.bringToFront`，不调用 `Runtime.enable` | Page domain 前台切换是否触发 |
| `native-evaluate-url-no-runtime-enable` | 连接 WebSocket 后直接 `Runtime.evaluate`，不先调用 `Runtime.enable` | 是否是 `Runtime.enable` 独有触发，还是 evaluate 本身触发 |
| `native-dom-read-no-runtime-enable` | 连接 WebSocket 后直接 `DOM.getDocument`，不先调用 `Runtime.enable` / `DOM.enable` | DOM domain 最小读取是否触发 |
| `native-input-move-no-runtime-enable` | 连接 WebSocket 后直接 `Input.dispatchMouseEvent(mouseMoved)`，不先调用 `Runtime.enable` | Input domain 最小事件是否触发 |
| `native-runtime-enable` | 原生 CDP 发送 `Runtime.enable` | 开启 Runtime domain 是否触发 |
| `native-evaluate-url` | 原生 CDP `Runtime.evaluate` 只读 `location.href` / `document.title` / 可见状态 | 最小页面 JS evaluate 是否触发 |
| `native-dom-read` | 原生 CDP `DOM.getDocument`，并只返回 DOM 数量/长度摘要 | DOM domain 读取是否触发 |
| `browser-attach` | 执行 `runtime.getBrowser()`，随后用原生 CDP 在 `watchMs` 内观察 URL/title | 仅建立 Playwright Browser CDP 连接是否触发异步回退 |
| `page-attach` | 执行 `ctxManager.getPage("zhipin")` | 绑定具体 BOSS 页面/context 是否触发 |
| `network-watch` | 在 `watchMs` 内监听相关 request/response 和 frame navigation | attach 后是否出现 `device-action-report` / APM / security 请求，或 URL 自动变化 |
| `page-evaluate` | 最小读取 `location.href`、`document.title`、`visibilityState` | 页面 JS evaluate 是否触发 |
| `detector-fingerprint` | 读取 `navigator.webdriver`、`window.cdc_*`、`__playwright__binding__` 等检测标志 | attach/evaluate 后是否暴露自动化指纹 |
| `storage-summary` | 读取 `localStorage`、`sessionStorage`、cookies 摘要 | storage/cookie 读取是否触发 |

orchestrator 使用规则：

1. 先调用 `zhipin_diagnose_browser_state()` 或 `zhipin_diagnose_browser_state({ phase: "native" })`
2. 如果 `nativePages` 中只有一个 BOSS 页，可继续递进；如果有多个 BOSS 页，后续必须传 `targetPageId`
3. 高风险账号先跑 `native-watch`，确认不 attach 时 URL 是否已经变化
4. 要验证“原生 CDP 是否可行”，先跑 `native-ws-connect`；若稳定，再优先跑 no-Runtime.enable 分支：`native-page-bring-front`、`native-evaluate-url-no-runtime-enable`、`native-dom-read-no-runtime-enable`、`native-input-move-no-runtime-enable`
5. 每次只推进一个阶段，并在每次调用后观察页面是否自动回退
6. 如果 `phase="browser-attach"` 返回 `success=false`，或 `nativeTimeline` 中出现 `phase="browser-attach-watch"` 且 `urlChangedFromPrevious=true`，立即停止；不要继续调用任何仍依赖 Playwright-backed 页面 attach 的 BOSS 工具，例如 `zhipin_send_reply`、`zhipin_filter_recommend_candidates`、`zhipin_say_hello`
7. 如果任意 `native-*-watch` 快照出现 `urlChangedFromPrevious=true`，停止继续加深原生 CDP 实验，并记录触发阶段
8. 只有需要复现 `Runtime.enable` 红线时，才跑 `native-runtime-enable`；如果该阶段触发，不要继续 `native-evaluate-url` / `native-dom-read` 这条 with-Runtime.enable 分支
9. 要验证“是否上报”，只能在 `browser-attach` 未触发 URL 变化后继续跑 `page-attach` / `network-watch`；工具会在可行时先挂网络监听再绑定 page
10. 一旦某个阶段触发回退，停止继续加深，记录该阶段的 `phases`、`nativeTimeline`、`networkEvents`、`navigationEvents`、`warnings`
11. `storage-summary` 返回的是脱敏摘要；禁止要求或传播 cookie/localStorage/sessionStorage 原始值

典型测试序列：

```json
{}
```

```json
{ "phase": "native-ws-connect", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

```json
{ "phase": "native-page-bring-front", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

```json
{ "phase": "native-evaluate-url-no-runtime-enable", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

```json
{ "phase": "native-dom-read-no-runtime-enable", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

```json
{ "phase": "native-input-move-no-runtime-enable", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

```json
{ "phase": "native-runtime-enable", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

```json
{ "phase": "browser-attach", "targetPageId": "<nativePages[].pageId>" }
```

```json
{ "phase": "page-attach", "targetPageId": "<nativePages[].pageId>" }
```

```json
{ "phase": "network-watch", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

```json
{ "phase": "page-evaluate", "targetPageId": "<nativePages[].pageId>" }
```

```json
{ "phase": "detector-fingerprint", "targetPageId": "<nativePages[].pageId>" }
```

```json
{ "phase": "storage-summary", "targetPageId": "<nativePages[].pageId>", "watchMs": 3000 }
```

返回结果重点：

- `nativePages`：原生 CDP 页面列表，`pageId` 可作为后续 `targetPageId`
- `targetPage`：本次绑定/诊断的 BOSS 页面
- `browserAttached` / `pageAttached`：是否已经进入更深 attach 阶段
- `nativeTimeline`：每个阶段后的原生 target URL/title 快照；`browser-attach-watch` 表示 Browser attach 成功后的后置观察窗口，`native-*-watch` 表示原生 CDP page WebSocket 阶段后的后置观察窗口；如果 `urlChangedFromPrevious=true`，优先认为该阶段和自动回退相关
- `nativeCdp`：原生 CDP page WebSocket 探测摘要，只包含是否连接、是否启用 Runtime、是否 bringToFront、URL/title 可见状态、DOM 节点数量/文本长度、最小 input 事件摘要，不包含页面正文
- `networkEvents`：只记录相关 APM/security 请求，不抓请求体；用于判断是否出现 `device-action-report` / `boss_risk_report` 等上报端点
- `navigationEvents`：记录 attach 后 frame URL 变化，用于定位自动 `history.back()` / 跳转发生在哪个阶段
- `detectorFingerprint`：读取自动化相关公开标志，如 `navigator.webdriver`、`window.cdc_*`、Playwright binding 标记
- `phases`：每个阶段的成功状态、耗时、错误
- `warnings`：多页面、未找到目标页、目标页不是 BOSS 页面、Browser attach 后 URL 变化等边界提示
- `storage`：只包含 key、value 长度、JSON 顶层形状、计数器差分、cookie 域/path/过期/HttpOnly/Secure/SameSite，不包含任何 token 或原始值

## BOSS直聘 — 聊天 Tools

- `zhipin_read_messages(limit?, onlyUnread?, sortBy?, autoScroll?, maxScrolls?)` — 使用 native CDP 只读 backend 读取消息列表，不触发 Playwright browser/page attach；默认返回全部消息，若只看未读，显式传 `onlyUnread=true`。默认 `autoScroll=true`，会向下滚动左侧消息列表内部容器并按 `conversationId` 合并去重；`maxScrolls` 默认 `4`，用于限制动态列表采集成本。native backend 不可用时返回 `success:false`，不会自动 fallback 到 Playwright；仍会保留页内视觉活动和虚拟鼠标反馈
- `zhipin_open_chat_page()` — 使用 native CDP backend 点击 Boss 左侧导航切换回「沟通」页；优先复用当前已登录的 Boss 页面，不让编排器去猜站内 URL；不触发 Playwright attach，仍保留页内视觉活动和虚拟鼠标反馈
- `zhipin_open_chat(conversationId?, candidateName?, index?, preferUnread?)` — 打开指定候选人的聊天窗口；匹配优先级是 `conversationId` > `candidateName` > `index`
- `zhipin_get_candidate_info(conversationId?, candidateName?, index?, maxMessages?)` — 提取候选人资料、聊天记录，以及当前选中聊天的 `conversationId` / `candidateId`。输出里的 `candidateInfo.communicationPosition`、`candidateInfo.expectedLocation`、`candidateInfo.expectedPosition` 已按“沟通职位 + 最近关注”结构化解析；若 `communicationPosition` 含连字符类分隔符（`-` / `－` / `—` / `–`），则取第一段作为可选 `preferredBrand`，否则不输出该字段
- `zhipin_send_reply(signedEnvelope, candidateName?, index?)` — 发送消息。只接受 Reply Authority Service 签发的 `signedEnvelope`；本地会先做 Ed25519 验签、过期检查、重放检查、目标绑定校验和 recruiter 绑定校验。启动期公钥预加载失败时直接前置拒绝，错误指向 `browser_status.replyAuthorityKeysLoaded`
- `zhipin_exchange_wechat(conversationId?, candidateName?, index?)` — 换微信。若已知 `conversationId`，优先传它；`candidateName/index` 只作兜底
- `zhipin_get_username()` — 使用 native CDP 只读 backend 获取当前登录的招聘者用户名，返回 `username`；依赖当前已有 BOSS native 页面，首次使用请先 `open_platform`，已打开但未跟踪页面可先 `list_pages + select_page`。native backend 不可用时返回 `success:false`，不会自动 fallback 到 Playwright；仍会保留页内视觉活动和虚拟鼠标反馈。常用于 recruiter binding 解析和外部通知消息中的账号标识

## BOSS直聘 — 聊天编排硬规则

聊天工具链必须把 `conversationId` / `candidateId` 当作稳定主键，而不是把左侧列表的瞬时 `index` 当主键。

原因：

- BOSS 左侧消息列表是虚拟列表，DOM 只保留当前窗口内的若干条记录
- 点击会话、发送消息、收到新消息后，列表会实时重排
- 同一个人上一轮是 `index=3`，下一轮可能已经变成 `index=0`
- `zhipin_open_chat` 不复用 `zhipin_read_messages` 的 DOM 句柄或索引缓存；它会重新读取当前页面上的 `.geek-item`，再按 `conversationId` > `candidateName` > `index` 匹配
- 因此 `index` 只适合“当前可见 DOM、没有滚动/过滤/重排后的即时兜底”，不适合跨 tool / 跨 agent 透传，也不能作为 `zhipin_read_messages` 到 `zhipin_open_chat` 的稳定点击映射

编排要求：

1. 先调用 `zhipin_read_messages`
2. 一旦返回了 `conversationId` / `candidateId`，后续所有 related tool 都复用这两个值
3. 调 `zhipin_open_chat` / `zhipin_get_candidate_info` / `zhipin_exchange_wechat` 时，优先传 `conversationId`
4. 调 `smart-reply-agent.generate_reply(..., target)` 时，`target.conversationId` / `target.candidateId` 必须直接来自 `browser-use-agent` 的真实输出
5. 禁止把 `zhipin_read_messages` 返回数组里的 `index` 当作后续 `zhipin_open_chat(index)` 的稳定句柄或会话主键
6. 只有在当前轮次拿不到 `conversationId` 时，才允许临时退回 `candidateName`
7. 只有在刚读取当前可见 DOM、且未发生滚动/过滤/列表重排时，才允许临时退回 `index`

动态列表要求：

- `zhipin_read_messages` 默认会自动滚动左侧消息列表；只有明确需要“只读当前可见 DOM”时才传 `autoScroll=false`
- 若要手动补采或诊断滚动状态，调用 `zhipin_scroll_view(surface="chat-list")`
- `onlyUnread=true` 时不要依赖 `limit` 提前停止采集；未读会话可能在当前首屏之后
- `zhipin_scroll_view(surface="chat-history", direction="up")` 可用于显式加载当前聊天更早的历史消息，但业务回复链路仍应优先用 `zhipin_get_candidate_info(conversationId)` 读取结构化详情

错误做法：

- 认为 `zhipin_read_messages` 已经建立了可复用的 `index -> DOM element` 点击映射
- `zhipin_read_messages` 拿到 `index=2`，几轮之后再调用 `zhipin_open_chat(index=2)`
- 用 `candidateName` 重新模糊匹配一个会话，再把历史 `candidateId` 假定为同一个人
- `smart-reply-agent` 的 `target` 不用 `browser-use-agent` 返回的 `conversationId/candidateId`，而是由 orch 自己重建
- 手动滚动后继续用旧的 `index` 打开候选人；滚动和动态渲染后 `index` 仍只表示当前 DOM 快照

推荐做法：

1. `zhipin_read_messages` → 记录 `conversationId + candidateId + candidateName`
2. `zhipin_open_chat(conversationId)`
3. `zhipin_get_candidate_info(conversationId)`
4. `smart-reply-agent.generate_reply(..., target={ platform, conversationId, candidateId, recruiterUsername|recruiterBinding })`
5. `zhipin_send_reply(signedEnvelope)`

## BOSS直聘 — 推荐列表 Tools

- `zhipin_open_recommend_page()` — 使用 native CDP backend 点击 Boss 左侧导航切换到「推荐牛人」页；优先复用当前已登录的 Boss 页面，不让编排器去猜站内 URL；不触发 Playwright attach，仍保留页内视觉活动和虚拟鼠标反馈
- `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)` — 在「推荐牛人」页打开筛选面板，只设置年龄、性别、活跃度[单选] 三个维度并提交。未传的维度会重置为 `不限`（年龄默认为 `16-不限`），不会点击岗位下拉，也不会清除学历、薪资、求职状态等其它筛选项
- `zhipin_get_candidate_list(maxResults?, autoScroll?, maxScrolls?)` — 使用 native CDP backend 获取推荐列表页的候选人卡片信息（姓名、年龄、学历、期望薪资等），不触发 Playwright attach。默认 `autoScroll=true`，会向下滚动推荐列表内部容器并按 `candidateId` / `data-geek` 合并去重；`maxScrolls` 默认 `4`。返回的 `scrollStats.stopReason` 可用于判断未达到 `maxResults` 的原因：`target-count`、`boundary`、`no-new-items`、`max-steps`
- `zhipin_say_hello(indices)` — 对推荐列表中的候选人批量点击「打招呼」
- `zhipin_open_resume(index)` — 点击候选人卡片打开简历详情弹窗
- `zhipin_locate_resume_canvas()` — 定位简历弹窗中嵌套 iframe 内的 canvas 坐标（用于截图）
- `zhipin_close_resume()` — 关闭简历详情弹窗

## BOSS直聘 — 动态列表滚动规则

BOSS 页面通常不是整页滚动，而是内部容器滚动：

```text
chat-list       -> 左侧消息列表，默认向下滚动，去重主键 conversationId
chat-history    -> 右侧聊天记录，默认向上滚动，用于加载更早历史
recommend-list  -> 推荐牛人列表，默认向下滚动，去重主键 candidateId/data-geek
```

使用原则：

1. 业务读取优先用自带 `autoScroll` 的工具：`zhipin_read_messages`、`zhipin_get_candidate_list`
2. `zhipin_scroll_view` 只作为显式翻页、调试和补救工具，不作为业务读取的必经步骤
3. 动态列表滚动后，`index` 会随当前 DOM 窗口变化；跨 tool 传递必须用 `conversationId` / `candidateId`
4. `maxScrolls` 用于成本控制；需要更完整列表时再显式调大，不要无界滚动
5. 推荐列表若 `total < maxResults`，先看 `scrollStats.stopReason`：`boundary` 表示触底后等待追加数据仍无新增，`no-new-items` 表示连续滚动没有新去重项，`max-steps` 表示到达滚动步数上限

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
2. `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)` → 需要限定目标人群时先设置年龄、性别、活跃度；例如“男性，20-40 岁，刚刚活跃”对应 `gender="男", ageMin=20, ageMax=40, activity="刚刚活跃"`
3. `zhipin_get_candidate_list(maxResults?, autoScroll=true, maxScrolls=4)` → 读取候选人卡片；默认会滚动动态列表并去重合并
4. `zhipin_say_hello(indices)` → 批量打招呼

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
