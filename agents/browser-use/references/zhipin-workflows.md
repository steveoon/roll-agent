# BOSS直聘业务编排细节

## 聊天主键

`conversationId` / `candidateId` 是跨 tool 的稳定主键，`index` 只表示当前 DOM 快照。

## 多账号 browserInstance 作用域

多 Boss 账号托管时，`browserInstance` 是账号/profile 路由键。orchestrator 必须把它贯穿同一账号任务的所有 browser-use 调用。

作用域规则：

1. 同一个账号线程固定一个 `browserInstance`，例如 `boss-a`。
2. 该线程中的 `zhipin_*`、`browser_snapshot`、`click_ref`、`type_ref`、`list_pages`、`select_page` 都显式传同一个 `browserInstance`。
3. `conversationId` / `candidateId` 是业务主键，但不替代 `browserInstance`；同一个候选会话仍必须在正确账号 profile 中执行。
4. `pageId`、`@eN`、`@cN`、`@jN`、`jobRef`、`candidateRef`、`preparedReplyId` 只在产生它们的 `browserInstance` 内有效。
5. 多实例没有 `browser.defaultInstance` 时，不传 `browserInstance` 的调用会返回 `needs_input`。
6. 不要把 `boss-a` 生成的 `preparedReplyId` 交给 `boss-b` 发送；发送工具会校验当前页面目标和招聘者绑定。

示例：

```json
{
  "browserInstance": "boss-a",
  "conversationId": "610630074-0",
  "maxMessages": 100
}
```

## BOSS 页面入口

`navigate_active_tab(url)` 是通用 native CDP 导航工具，但不能直接跳转 BOSS `/web/chat/*` 后台路径。

页面切换规则：

1. 进入聊天页：调用 `zhipin_open_chat_page()`，由工具点击站内「沟通」导航。
2. 进入推荐牛人页：调用 `zhipin_open_recommend_page()`，由工具点击站内「推荐牛人」导航。
3. 如果页面没有可用 BOSS 后台 target，不要用 `navigate_active_tab("https://www.zhipin.com/web/chat/recommend")` 补救；让用户先恢复登录后的 BOSS 页面或调用 `open_platform("zhipin")` 进入平台主页。
4. `navigate_active_tab` 不触发 Playwright attach，也不调用 `Runtime.enable`，但它不替代 BOSS 业务语义导航工具。

错误做法：

- 把 `zhipin_read_messages` 返回数组里的 `index` 当作后续点击主键。
- 手动滚动或列表重排后继续使用旧 `index`。
- 用 `candidateName` 模糊匹配会话后，把历史 `candidateId` 假定为同一人。
- 由 orchestrator 自己重建 `target.conversationId` / `target.candidateId`。

推荐做法：

1. `zhipin_read_messages` 记录 `conversationId + candidateId + candidateName`。
2. `zhipin_generate_reply_preview({ browserInstance, conversationId })`。
3. `zhipin_send_prepared_reply({ browserInstance, preparedReplyId })`。
4. 发送后用 `zhipin_read_messages({ browserInstance, onlyUnread:true })` 或目标会话读取做验证。

## 推荐岗位筛选

推荐牛人页顶部岗位下拉的稳定主键是 `.job-list .job-item[value]`。

优先级：

1. 先调用 `zhipin_list_recommend_jobs()` 读取当前岗位下拉，只读不切换。
2. 如果 `canSwitch:false`，当前账号/页面没有可切换岗位，跳过岗位切换。
3. 已知 `jobRef` 时，调用 `zhipin_select_recommend_job({ jobRef })`。
4. 已知岗位 `value` 时，调用 `zhipin_select_recommend_job({ jobValue })`。
5. 只知道标题时，调用 `zhipin_select_recommend_job({ jobName })`；工具会先匹配当前下拉项，未命中再使用下拉搜索框。
6. `index` 只表示当前下拉快照顺序，筛选、搜索或岗位列表刷新后必须重新读取/选择，不要跨步骤长期保存。

`jobRef` 规则：

- `jobRef` 格式如 `@j1`，只来自 `zhipin_list_recommend_jobs()` 输出。
- `jobRef` 只对最近一次岗位下拉快照有效；筛选、搜索、刷新、页面 reload 或页面重开后必须重新读取。
- orchestrator 不要自行构造 `jobRef`。
- `jobRef` 不是安全边界，只是降低编排认知负担；真实 DOM 点击仍由工具解析到 `value` / `index` 后执行。
- 默认不要传 `forceClick:true`；只有需要重新点击已选中的岗位项时才使用。

推荐链路：

```text
zhipin_open_recommend_page()
  -> zhipin_list_recommend_jobs()
  -> zhipin_select_recommend_job({ jobRef | jobValue | jobName })  # 可选；canSwitch=false 时跳过
  -> zhipin_filter_recommend_candidates(...)  # 可选；requires_vip 时跳过
  -> zhipin_get_candidate_list(...)
```

## 推荐候选人筛选

`zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)` 只处理年龄、性别、活跃度三个维度。

返回状态处理：

| `status` | 含义 | 编排动作 |
| --- | --- | --- |
| `applied` | 筛选已提交 | 继续 `zhipin_get_candidate_list` |
| `recommend_not_ready` | 推荐页未就绪 | 先调用 `zhipin_open_recommend_page()` |
| `requires_vip` | 当前账号没有权限使用该筛选，页面触发 VIP 弹窗 | 不要反复尝试绕过；跳过筛选或调整业务策略 |
| `error` | 操作失败 | 读取 `error` 后决定是否重试 |

实操规则：

1. `requires_vip` 是硬边界，不是暂态加载失败。
2. 如果筛选不可用，直接读取当前推荐列表，再由 orchestrator 按 `age`、`buttonText`、岗位信号等字段做结果过滤。
3. 列表字段过滤不能替代平台筛选的完整语义；它只用于降低明显不合适目标的后续操作风险。

## 动态列表

BOSS 页面通常不是整页滚动，而是内部容器滚动：

```text
chat-list       -> 左侧消息列表，默认向下滚动，去重主键 conversationId
chat-history    -> 右侧聊天记录，默认向上滚动，用于加载更早历史
recommend-list  -> 推荐牛人列表，默认向下滚动，去重主键 candidateId/data-geek
```

规则：

1. 业务读取优先用自带 `autoScroll` 的工具：`zhipin_read_messages`、`zhipin_get_candidate_list`。
2. `zhipin_scroll_view` 只用于显式翻页、调试和补救。
3. 只想检查聊天列表是否到顶/到底时调用 `zhipin_scroll_view({ surface: "chat-list", steps: 0 })`，读取顶层 `atTop` / `atBottom` / `canScrollUp` / `canScrollDown` / `position`。
4. `onlyUnread=true` 时不要依赖 `limit` 提前停止；未读会话可能在首屏之后。
5. `maxScrolls` 用于成本控制，需要更完整列表时显式调大。
6. 推荐列表若 `total < maxResults`，先看 `scrollStats.stopReason`：
   - `target-count`：已达到目标数量。
   - `boundary`：触底并等待追加数据后仍无新增。
   - `no-new-items`：连续滚动没有新去重项。
   - `max-steps`：达到滚动步数上限。

## preferredBrand / preferredBrandId

`zhipin_get_candidate_info` 会从页面信号中解析：

- `expectedLocation` / `expectedPosition`（来自期望职位文本）
- `preferredBrandId` 或 `preferredBrand`（来自 `candidateInfo.communicationPosition`，互斥，最多输出一个）

沟通职位有两种命名格式，解析规则：

- 新格式 `自定义描述…[品牌ID]`（末尾方括号包数字，兼容全角 `【】` / `［］` 与括号内空白）：输出 `preferredBrandId`，例如 `咖啡早班店员-接受小白-免费咖啡[10027]` -> `preferredBrandId: 10027`。此时**不输出** `preferredBrand`——新格式第一段是岗位描述，不是品牌名。
- 老格式 `品牌名-职位`（含连字符类分隔符 `-` / `－` / `—` / `–`，且无 ID 尾缀）：取第一段输出 `preferredBrand`，例如 `肯德基-服务员` -> `preferredBrand: "肯德基"`。
- 两者都不满足时不输出任何品牌字段。
- 编排器原样透传工具输出即可，不要自行解析 `communicationPosition`；Reply Authority 服务端会以 `candidateInfo.communicationPosition` 为权威再次提取品牌 ID 并与 `preferredBrandId` 对账（不一致以服务端提取为准）。
- 禁止用通用岗位名或 `zhipin_get_candidate_list.company` 伪造品牌；禁止把新格式的第一段当品牌名。

## 地点证据（服务端提取）

地点证据提取已收编进 Reply Authority 服务端的 turn_planning 阶段（RFC pipeline-latency-restructure M1）：browser-use 只上送原始对话与候选人资料，服务端 `planTurn` 合并提取地点信号并做逐字证据校验，再交给 geocode 与门店/岗位距离匹配。

`zhipin_generate_reply_preview` 通过 SSE `location.resolved` 事件回显服务端提取结果：

```json
{
  "type": "location.resolved",
  "inquiryType": "location_inquiry",
  "analysisPath": "llm",
  "signals": [
    {
      "text": "人民广场",
      "source": "candidate_message",
      "city": "上海",
      "intent": "nearby_store",
      "confidence": 0.93
    }
  ]
}
```

`source` 取值（与 `@roll-agent/reply-authority-client` 契约一致）：

| `source` | 含义 |
| --- | --- |
| `candidate_message` | 候选人消息中的地点片段（最高优先级） |
| `conversation_history` | 近几轮对话中的地点引用 |
| `candidate_expected_location` | 候选人资料里的期望城市/区域（弱信号） |
| `communication_position` | 沟通岗位文本中可确认的城市/门店片段 |

`intent` 常见取值：`nearby_store`（附近门店/岗位）、`store_address`（门店地址）、`expected_area`（期望区域）。`analysisPath` 取值：`llm`（planTurn 合并提取）、`speculative`（词典投机命中）、`none`（无地点信号）。

规则与边界：

1. browser-use 不抽取地点、不调用外部地图、不做 geocode、不计算门店距离；上送的对话原文是服务端提取的唯一证据源。
2. `candidateInfo.expectedLocation` 只作城市边界弱信号（服务端 confidence 封顶 0.6），不能替代候选人本轮追问的具体 POI。
3. orchestrator 不要自行构造或改写地点信号：`generate_reply` 请求中的 `locationSignals` 字段已废弃，服务端过渡期内会逐字校验后合并，两个版本周期后忽略。
4. `zhipin_get_candidate_info` 输出中的 `locationSignals` 恒为空数组，仅为输出契约兼容保留，不要依赖。
5. 岗位/门店事实源仍是下游同步的岗位配置；外部地图 POI 不能当作门店或岗位事实。
6. `smart-reply-agent.generate_reply` 只校验 schema 并原样转发（deprecated 字段同样适用），不做地点推断。

## Reply Authority

`zhipin_send_prepared_reply` 只接受 `zhipin_generate_reply_preview` 生成的 `preparedReplyId`，从 prepared store 读取预览阶段保存的 Reply Authority 签名 envelope 并完成验签。

发送前校验：

1. 启动期公钥预加载状态：`browser_status.replyAuthorityKeysLoaded`。
2. Ed25519 签名。
3. envelope 过期时间。
4. replay `jti` 是否已消费。
5. 当前选中聊天是否匹配 `conversationId + candidateId`。
6. 当前登录招聘者是否匹配 `recruiterBinding`。
7. 当前 `browserInstance` 是否仍是生成 `preparedReplyId` 的账号/profile 作用域。

`generate_reply` 的 `target` 两种模式：

```json
{
  "platform": "zhipin",
  "tenantId": "tenant-001",
  "conversationId": "conversation-1",
  "candidateId": "candidate-1",
  "recruiterBinding": { "platform": "zhipin", "username": "郭晓阳" }
}
```

```json
{
  "platform": "zhipin",
  "conversationId": "conversation-1",
  "candidateId": "candidate-1",
  "recruiterUsername": "郭晓阳"
}
```

第二种代理模式由当前 Agent 使用的共享 `reply-authority-client` 先调用 Reply Authority resolver，解析出 `tenantId + recruiterBinding`；`browser-use-agent` 与 `smart-reply-agent` 都能独立完成该解析，不需要为了 resolver 在两者之间跳转。

### RFC V3 双稿反馈闭环

当前 browser-use 双稿链路要求 Reply Authority RFC V3；部署顺序必须是 **Reply Authority V3 → 新版 browser-use-agent**。调用方 token 必须能访问目标租户并具备 `reply-feedback:write`。

```text
preview 保存 group / rubric / feedbackExpiresAt
  -> send 内部 Judge，或复用独立 Judge / orchestrator 显式选择
  -> 发送一份签名 option
  -> 将 selected 或 not_learned 终态写入 SQLite outbox
  -> POST /reply-feedback
```

| `feedbackOutcome` | `decisionSource` | Beta 学习 | Pending |
| --- | --- | --- | --- |
| `selected` | `judge` / `orchestrator` | 更新 | 闭合 |
| `not_learned` | `service_recommended_fallback` / `explicit_no_judge` | 不更新 | 闭合 |

`zhipin_judge_prepared_reply` 只是可选预览工具；默认直接调用 send 即可，send 会在双稿缺少 `variantDecision` 时确定性执行并缓存 Judge。若 preview 阶段 rubric 拉取、hash 或双稿结构异常，prepared store 会保留 group 生命周期元数据；send 发送顶层推荐稿成功后提交 `not_learned`，不会让服务端 Pending 静默过期。

发送后的 feedback 状态：

| `feedbackStatus` | 用户消息 | feedback 闭环 | 后续动作 |
| --- | --- | --- | --- |
| `accepted` / `duplicate` | 已发送 | 已闭合 | 无需处理 |
| `queued` | 已发送 | 等待 outbox 重试 | 不重调 send；等待 outbox 仅重试 POST |
| `failed` | 已发送 | 有缺口 | 不重调 send；修复 token、服务或 outbox 后单独排查 |

`feedbackExpected:false` 只表示 fallback/no-Judge 不进入 Beta 学习，不表示无需终态。outbox 的实际重试截止时间取服务端 `feedbackExpiresAt` 与本地 retention 的较早值。

跨服务 fallback 只使用稳定安全码，原始 provider / HTTP / parser 错误只留在 browser-use-agent 本地日志：

| Code | 含义 |
| --- | --- |
| `rubric_fetch_failed` | rubric 获取失败 |
| `rubric_mismatch` | rubric version/hash 不一致 |
| `invalid_variant_shape` | 服务端双稿结构无法安全判定 |
| `judge_sampling_failed` | MCP Sampling 调用失败 |
| `judge_output_invalid` | Judge 输出无法验证 |

## 推荐候选人链路

1. `zhipin_open_recommend_page()`。
2. `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)`（可选；`requires_vip` 时跳过）。
3. `zhipin_get_candidate_list(maxResults?, autoScroll=true, maxScrolls=4)`。
4. orchestrator 过滤 `buttonText` / 年龄 / 业务资格。
5. `zhipin_say_hello(candidateRefs)`。

`zhipin_get_candidate_list` 会给每个候选人返回 `candidateRef`，例如 `@c1`。

优先级：

1. 上层 orchestrator 优先把 `candidateRef` 传给 `zhipin_say_hello({ candidateRefs })` 或 `zhipin_open_resume({ candidateRef })`。
2. `indices` / `index` 只作为当前 DOM 快照兜底。
3. 筛选、滚动加载、搜索、刷新、页面 reload 或页面重开后必须重新调用 `zhipin_get_candidate_list`，不要复用旧 `candidateRef`。
4. 不要由 orchestrator 自己构造 `@c1`；只使用 tool 输出中的 `candidateRef`。
5. 聊天消息列表没有 `candidateRef`；聊天回复链路继续使用 `conversationId` / `candidateId`。
6. 调 `zhipin_say_hello` 前先过滤 `buttonText:"打招呼"`；`buttonText` 为空通常表示已打过招呼，不应重复点击。
7. 如果业务有年龄、资格或岗位匹配约束，先按 `age` / `expectedPosition` / `tags` 等字段过滤，不要把所有 `candidateRefs` 盲目提交。

失效保护：

- 如果 `candidateRef` 对应的 `candidateId` / `name` 与当前 DOM 不一致，工具会返回 `success:false` 并提示“候选人引用已过期”。
- 收到过期提示后，重新执行推荐候选人链路的第 3 步，再提交新的 `candidateRefs`。
- 同一快照内可以一次提交多个 `candidateRefs` 连续打招呼；如果 BOSS 在点击后重排列表，工具会拒绝过期 ref，orchestrator 应刷新列表后只重试剩余目标。

## 长跑 tab 的 reload recovery

Chrome 全天不关、同一沟通 tab 连续跑多批任务时，前端 SPA 状态会在同一 renderer 内累积，常见症状是 `.geek-item.selected` 选中态丢失、依赖「当前选中聊天」的工具（如 `zhipin_exchange_wechat`）失败，且失败率随运行时长上升。

recovery 优先级与边界：

1. `zhipin_open_chat_page({ forceReload: true })`：只对当前沟通页执行 native CDP `Page.reload`，等价手动 F5，清空当前 document 的 DOM 与页面内 SPA 状态，保留 Chrome 窗口与 profile 登录态；reload 后返回 `usedReload: true` 与 `chatReady`。如果实时页面已不是沟通页，会跳过 reload 并返回 `reloadSkippedReason`。
2. 通用 `browser_reload_active_tab`：对当前 tracked native page 做同样的 reload，用于非沟通页或不需要确认聊天就绪的场景。
3. 普通 `zhipin_open_chat_page()`（不带 forceReload）在已处于沟通页时只返回 `alreadyOnChat: true`，**不会**卸载 document，无法清状态。
4. `roll browser stop` 才能回收 renderer 进程内存，但会关闭浏览器窗口；reload 只清 document 级状态，**不保证** renderer 把内存归还 OS。

reload / 页面重开后，所有 `@eN` / `candidateRef` / `jobRef` 一律失效，必须重新 `browser_snapshot` 或重新读列表后再继续。
