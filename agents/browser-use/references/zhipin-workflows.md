# BOSS直聘业务编排细节

## 聊天主键

`conversationId` / `candidateId` 是跨 tool 的稳定主键，`index` 只表示当前 DOM 快照。

错误做法：

- 把 `zhipin_read_messages` 返回数组里的 `index` 当作后续点击主键。
- 手动滚动或列表重排后继续使用旧 `index`。
- 用 `candidateName` 模糊匹配会话后，把历史 `candidateId` 假定为同一人。
- 由 orchestrator 自己重建 `target.conversationId` / `target.candidateId`。

推荐做法：

1. `zhipin_read_messages` 记录 `conversationId + candidateId + candidateName`。
2. `zhipin_open_chat(conversationId)`。
3. `zhipin_get_candidate_info(conversationId)`。
4. `smart-reply-agent.generate_reply(..., target)`。
5. `zhipin_send_reply(signedEnvelope)`。

## 推荐岗位筛选

推荐牛人页顶部岗位下拉的稳定主键是 `.job-list .job-item[value]`。

优先级：

1. 已知岗位 `value` 时，调用 `zhipin_select_recommend_job({ jobValue })`。
2. 只知道标题时，调用 `zhipin_select_recommend_job({ jobName })`；工具会先匹配当前下拉项，未命中再使用下拉搜索框。
3. `index` 只表示当前下拉快照顺序，筛选、搜索或岗位列表刷新后必须重新读取/选择，不要跨步骤长期保存。

推荐链路：

```text
zhipin_open_recommend_page()
  -> zhipin_select_recommend_job({ jobValue | jobName })
  -> zhipin_filter_recommend_candidates(...)
  -> zhipin_get_candidate_list(...)
```

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

## preferredBrand

`zhipin_get_candidate_info` 会从 `candidateInfo.communicationPosition` 中解析：

- `expectedLocation`
- `expectedPosition`
- `preferredBrand`

`preferredBrand` 规则：

- 仅当 `communicationPosition` 含连字符类分隔符时输出：`-` / `－` / `—` / `–`。
- 取分隔符前的第一段，例如 `肯德基-服务员` -> `preferredBrand: "肯德基"`。
- 没有分隔符时不输出。
- 禁止用通用岗位名或 `zhipin_get_candidate_list.company` 伪造品牌。

## Reply Authority

`zhipin_send_reply` 只接受 Reply Authority Service 签发的 `signedEnvelope`。

发送前校验：

1. 启动期公钥预加载状态：`browser_status.replyAuthorityKeysLoaded`。
2. Ed25519 签名。
3. envelope 过期时间。
4. replay `jti` 是否已消费。
5. 当前选中聊天是否匹配 `conversationId + candidateId`。
6. 当前登录招聘者是否匹配 `recruiterBinding`。

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

第二种代理模式由 `smart-reply-agent` 调用 Reply Authority resolver 解析 `tenantId + recruiterBinding`。

## 推荐候选人链路

1. `zhipin_open_recommend_page()`。
2. `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)`。
3. `zhipin_get_candidate_list(maxResults?, autoScroll=true, maxScrolls=4)`。
4. `zhipin_say_hello(candidateRefs)`。

`zhipin_get_candidate_list` 会给每个候选人返回 `candidateRef`，例如 `@c1`。

优先级：

1. 上层 orchestrator 优先把 `candidateRef` 传给 `zhipin_say_hello({ candidateRefs })` 或 `zhipin_open_resume({ candidateRef })`。
2. `indices` / `index` 只作为当前 DOM 快照兜底。
3. 筛选、滚动加载、搜索、刷新或页面重开后必须重新调用 `zhipin_get_candidate_list`，不要复用旧 `candidateRef`。
4. 不要由 orchestrator 自己构造 `@c1`；只使用 tool 输出中的 `candidateRef`。

失效保护：

- 如果 `candidateRef` 对应的 `candidateId` / `name` 与当前 DOM 不一致，工具会返回 `success:false` 并提示“候选人引用已过期”。
- 收到过期提示后，重新执行推荐候选人链路的第 3 步，再提交新的 `candidateRefs`。
