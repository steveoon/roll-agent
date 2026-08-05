# Roll Runtime Protocol v1 参考

## 版本与入口

| 项目 | 值 |
|---|---|
| 最新 Wire protocol | `"1.3"` |
| 兼容 Wire protocol | `"1.2"`、`"1.1"`、`"1.0"` |
| 正式命令 | `roll runtime serve --stdio` |
| 兼容命令 | `roll chat --server` |
| Event notification | `runtime.event` |
| Server Request cancel notification | `runtime.serverRequest.cancel` |
| 分帧 | NDJSON，一行一个 JSON-RPC 消息 |
| Runtime 默认接收入站帧上限 | `4 MiB`；通过初始化结果返回 |
| 1.3 Client 入站帧最低能力 | `17 MiB`；预算更低的 Client 不得广告 1.3 |
| Event replay | 1.3 只重放 durable event；1.2/1.1/1.0 不支持 |

Schema 单一数据源位于 `@roll-agent/protocol`。构建后可读取最新的
`@roll-agent/protocol/schema`，或显式读取 `schema/1.3`、`schema/1.2`、`schema/1.1`、
`schema/1.0` 的 JSON Schema Draft 2020-12 根 Schema；其 `$defs`
包含各方法 params/result/request、Server Request 以及 JSON-RPC response/event
定义；`x-roll-methods` 和 `x-roll-server-request-methods` 提供代码生成索引。
跨语言 fixture 位于 `@roll-agent/protocol/fixtures/v1.3/*` 与
`@roll-agent/protocol/fixtures/v1.2/*`；冻结的 1.1/1.0 fixture 继续共用
`@roll-agent/protocol/fixtures/v1/*`。

TypeScript 宿主可直接从包根导入：

- `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`RUNTIME_PROTOCOL_VERSION`、
  `RUNTIME_METHODS`、`RUNTIME_SERVER_REQUEST_METHODS`、
  `RUNTIME_PROTOCOL_CAPABILITIES`、`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION`、
  `RUNTIME_ERROR_CODES`；
- `RUNTIME_PROTOCOL_REGISTRY`、`getRuntimeProtocolRegistry()`、
  `getRuntimeProtocolCapabilities()`、`isRuntimeMethodAvailable()`、
  `isRuntimeServerRequestMethodAvailable()`、`isRuntimeServerRequestMethodRequired()`、
  `isLatestRuntimeServerRequestMethod()`；
- latest `runtimeMethodSchemas`，以及冻结为 1.1 facade 的
  `parseRuntimeMethodParams()`、`parseRuntimeMethodResult()`；
- `runtimeServerRequestSchemas`、`parseRuntimeServerRequestParams()`、
  `parseRuntimeServerRequestResult()`；
- `parseRuntimeMethodParamsForVersion()`、`parseRuntimeMethodResultForVersion()`、
  `parseRuntimeServerRequestParamsForVersion()`、
  `parseRuntimeServerRequestResultForVersion()` 与 version-aware cancel/error parser；
- `runtimeEventEnvelopeSchema`、`runtimeDurableEventEnvelopeV13Schema`、
  `runtimeEphemeralEventEnvelopeV13Schema`、`runtimeEventIdSchema`、
  `runtimeEventCursorSchema`、`compareRuntimeEventCursors()`、
  `runtimeEventCursorDistance()` 及各领域 Schema；
- `RuntimeMethodInput<TMethod>`、`RuntimeMethodParams<TMethod>`、
  `RuntimeMethodResult<TMethod>`；
- `RuntimeServerRequestInput<TMethod>`、`RuntimeServerRequestParams<TMethod>`、
  `RuntimeServerRequestResult<TMethod>`；
- `InteractionId`、`RuntimeEventId`、`RuntimeEventCursor`、
  `RuntimeMethodForVersion<TVersion>`、
  `RuntimeServerRequestInputForVersion<TVersion,TMethod>`、
  `RuntimeServerRequestParamsForVersion<TVersion,TMethod>`、
  `RuntimeServerRequestResultForVersion<TVersion,TMethod>`、
  `LatestRuntimeServerRequestInput/Params/Result<TMethod>`、
  `RuntimeServerRequestInput/Params/ResultForSupportedVersions<TMethod>`、
  `ThreadSnapshot`、`RuntimeEventEnvelope` 等 DTO 类型。

未带 `ForVersion` 的 Runtime method parser/type、Approval params/cancel/error helper 是冻结的
1.1 兼容 facade；`runtimeMethodSchemas` 与 `LatestRuntimeServerRequest*` 则表示最新 registry。
新代码处理 1.3/1.2/1.1/1.0 矩阵时应按协商版本调用 version-aware helper，避免把新版字段
泄漏到旧 wire。

`@roll-agent/protocol` 只定义协议、Schema 和类型，不负责启动 Runtime 或管理连接。Node
进程生命周期由 [`@roll-agent/client-node`](./client-node-reference.md) 负责；远程
Web 接入使用由
[`@roll-agent/relay-protocol`](./companion-relay-v1-reference.md) 定义的独立 Relay v1
协议，并由用户本机 `@roll-agent/companion` Host 转接到 Runtime。

`RUNTIME_PROTOCOL_VERSION` 表示当前包提供的**最新 wire schema 版本**，适合 Server 默认值、
Schema 生成与 fixture 标注；它不表示任意调用方已经实现该版本要求的入站能力。直接使用
`@roll-agent/protocol` 的 Client 升级依赖后，必须审查新增的 Runtime→Client Request 与
Notification，并只在 `initialize.protocolVersions` 中广告自己确实实现的版本。
`RollNodeClient` 会按强制 handler 规则生成版本列表，并在 1.3/1.2 初始化后自动完成
Client capability handshake。

Protocol 1.3 的单条 durable event record 最多为 `16 MiB`；加上 Runtime envelope 与
JSON-RPC notification 元数据后，广告 `"1.3"` 即声明 Client 能接收至少 `17 MiB` 的单个
Runtime→Client NDJSON 帧。本地入站预算低于该值的 Client 必须省略 `"1.3"`。初始化结果中的
`limits.maxFrameBytes` 表示 Runtime 接收 Client 出站帧的上限；初始化后的 Client 出站上限
仍取本地预算与该值的较小值，不能把 17 MiB 入站要求解释为同等的出站额度。

## 初始化

客户端必须首先且仅调用一次 `initialize`：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersions": ["1.3", "1.2", "1.1", "1.0"],
    "client": { "name": "my-gui", "version": "1.0.0" }
  }
}
```

结果包含协商版本、`runtimeInstanceId`、Server 信息、能力和限制。`limits` 会返回
`maxFrameBytes`、`maxPageSize`、`eventReplay` 和 `idempotencyCacheEntries`；客户端发送
前必须遵守协商后的单帧上限。当前 Runtime 默认返回：

| limit | 当前默认值 | 语义 |
|---|---:|---|
| `maxFrameBytes` | `4 * 1024 * 1024` | Server 接受的单个 NDJSON 帧上限 |
| `maxPageSize` | `500` | 分页请求允许的最大 `limit` |
| `eventReplay` | 1.3 为 `true`；旧版本为 `false` | 是否提供 durable event 持久重放 |
| `idempotencyCacheEntries` | `10,000` | 已完成 mutation 的进程内缓存窗口 |

这些值是协商结果，不应在客户端写死。旧 `session.*` RPC 在兼容期内不要求 v1 初始化。

Runtime 按客户端 `protocolVersions` 的顺序选择第一个双方支持的版本：

| Client 能力 | 广告版本 | 新 Runtime 协商结果 | Approval 控制路径 |
|---|---|---|---|
| 已注册 `approval.request` handler | `["1.3","1.2","1.1","1.0"]` | `"1.3"` | capability ACK 后的 Server Request |
| 未注册 Server Request handler | `["1.3","1.2","1.0"]` | `"1.3"` | ACK 空集合；Runtime 不投递 Approval |
| N-1 Client | `["1.1","1.0"]` | `"1.1"` | Server Request |
| 旧 Client | `["1.0"]` | `"1.0"` | Event + `approval.respond` |
| 无共同版本 | 例如 `["2.0"]` | `PROTOCOL_VERSION_UNSUPPORTED` | 不建立协议会话 |

版本能力表由 `RUNTIME_PROTOCOL_CAPABILITIES` 提供：

| 字段 | `"1.3"` | `"1.2"` | `"1.1"` | `"1.0"` |
|---|---|---|---|---|
| `serverRequests` | `true` | `true` | `true` | `false` |
| `serverRequestCapabilityNegotiation` | `true` | `true` | `false` | `false` |
| `approvalResolvedEvents` | `true` | `true` | `true` | `false` |
| `clientApprovalResponses` | `false` | `false` | `false` | `true` |
| `requiredServerRequestMethods` | `[]` | `[]` | `["approval.request"]` | `[]` |

新 Client 向旧 Runtime 发送 `["1.3","1.2","1.1","1.0"]` 时，旧 Runtime 可选择 `"1.2"`、`"1.1"`
或 `"1.0"`；strict `initialize` params 没有增加 capability 字段。协商结果属于当前
连接，1.0/1.1 连接不能动态开启 1.3/1.2 capability。`@roll-agent/client-node` 总能广告
没有强制 handler 的 1.2；使用至少 17 MiB 本地入站预算时也会广告 1.3。只有覆盖
`approval.request` 时才同时广告要求该 handler 的 1.1。
同一连接重复调用 `initialize` 会返回 `CAPABILITY_UNAVAILABLE`，且不会改变已经固定的
协议版本与控制路径。

`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION` 只描述某个 wire 版本的**必需**
Client handler，是从上述能力表派生的兼容导出。1.3/1.2 registry 包含可选的
`approval.request` 与 `userInput.request`；未来 method 也必须通过 1.3/1.2 capability 集合显式
启用，不能静默追加到 1.1 的必需方法中。

### 1.3/1.2 Client capability handshake

协商到 `"1.3"` 或 `"1.2"` 后，Client 必须先调用：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "client.capabilities.set",
  "params": {
    "revision": 1,
    "serverRequestMethods": ["approval.request", "userInput.request"]
  }
}
```

`revision` 是从 1 开始的严格递增整数；method 最多 64 项、单项 1..100 字符且不可重复。
Client 可以发送未来未知 method，Runtime 返回按自身 registry 顺序排列的交集：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "revision": 1,
    "acceptedServerRequestMethods": ["approval.request", "userInput.request"]
  }
}
```

Client 必须按集合语义处理 `acceptedServerRequestMethods`：它是请求集的子集，顺序以
Runtime registry 为准，可以为空；只有出现未请求的 method 才构成协议违例。被 Runtime
丢弃的 method 不进入已协商集合，其 Server Request 到达 Client 时应答 `-32601`。

同 revision、同 method 集合是幂等重试；旧 revision，或同 revision 配不同集合，返回
`CAPABILITY_REVISION_CONFLICT`。ACK 前 Runtime 不得投递 Interaction；ACK 响应帧先于
其后任何新 Interaction 的投递帧写出。
`RollNodeClient.connect()` / `start()` 会等待首个 ACK 后才返回；动态注册或撤销
handler 会串行发送更高 revision。撤销 method 会终止该 method 的未决 Interaction，
迟到 Result 不能结算。

第一次调用 Runtime Protocol 方法或 legacy `session.*` 方法后，连接会锁定对应协议家族。
同一连接不能混用两套方法；例如完成 `initialize` 后调用 `session.approve` 会返回
`CAPABILITY_UNAVAILABLE`。这个边界防止 1.3/1.2/1.1 Approval 绕过 Server Request 控制路径。

## ID 类型

| 字段 | Wire 类型 | 约束 |
|---|---|---|
| JSON-RPC `id` | `string` 或 `number` | 请求/响应关联；错误响应还可能为 `null` |
| `interactionId` | `string` | 1.3/1.2 逻辑 Interaction UUID；显式重投时保持稳定 |
| `eventId` | `string` | 1.3 durable event UUID；只用于事件去重 |
| `cursor` / Snapshot `eventCursor` | `string` | 1.3 不透明 `rte1:<eventLogId>:<threadSequence>:<eventId>`；不得拆解生成 |
| cancel `serverRequestId` | `string` 或 `number` | 仅 1.1；被取消投递的 JSON-RPC `id` |
| `threadId`, `turnId`, `approvalId` | `string` | UUID |
| `runtimeInstanceId`, `requestId` | `string` | UUID |
| `streamId`, `operationId` | `string` | UUID |
| `toolCallId`, `reasoningId` | `string` | 非空字符串，不保证 UUID |
| `thread.list.cursor` | `string` | 十进制数字字符串 |
| Snapshot `*BeforeSequence` | `number` | 非负整数 |

Interaction 链路必须分开以下身份：

- JSON-RPC `id` 只标识当前连接上的一次 Server Request 投递；
- 1.3/1.2 `interactionId` 标识逻辑交互，显式重投会换 JSON-RPC `id` 但保持它；
- 1.1 cancel `serverRequestId` 原样引用 JSON-RPC `id`；
- `approvalId` 是 Approval 领域对象 ID，可出现在 Snapshot 与 View Event 中；
- mutation `requestId` 只用于 Client → Runtime 写操作幂等，不参与 Server Request 响应。

当前 stdio 协议断线即取消，不定义持久或跨进程 Request 恢复。当前进程内的显式重投复用
`interactionId` 与原始 deadline，不复用 JSON-RPC `id`，也不延长 deadline。

## 方法

| 方法 | 分类 | 关键输入 | 输出 |
|---|---|---|---|
| `initialize` | 握手 | 版本列表、客户端信息 | 版本、实例、features、limits |
| `client.capabilities.set` | `"1.3"` / `"1.2"` 握手扩展 | `revision`, `serverRequestMethods` | revision 与 Runtime registry 交集 |
| `thread.list` | 只读 | `cursor?`, `limit?` | Thread 分页 |
| `thread.create` | mutation | `requestId`, `title?` | `ThreadSummary` |
| `thread.open` | 附着/恢复 | `threadId` | `ThreadSnapshot` |
| `thread.snapshot` | 只读 | 两个独立 before sequence、`limit?` | `ThreadSnapshot` |
| `runtime.events.resume` | `"1.3"` 恢复 | `threadId`, `afterCursor` | replay barrier `{ throughCursor, replayedCount }` |
| `thread.rename` | mutation | `requestId`, `threadId`, `title` | 更新后的 Thread |
| `thread.delete` | mutation | `requestId`, `threadId` | `{ deleted: true }` |
| `thread.detach` | mutation | `requestId`, `threadId` | `{ detached: boolean }` |
| `thread.capabilities` | 只读 | `threadId` | 安全 Capability manifest |
| `turn.start` | mutation | `requestId`, `threadId`, `turnId`, 文本输入 | 立即返回 `accepted` |
| `turn.cancel` | mutation | `requestId`, `threadId`, `turnId` | `{ cancelling: boolean }` |
| `approval.respond` | `"1.0"` mutation | `requestId`, IDs, decision | `{ resolved: true }` |
| `operation.get` | 只读 | `threadId`, `operationId` | 脱敏 Operation 或 `null` |

`thread.open` 会恢复并附着活动 Session，因此不是纯读取；它没有 `requestId`，不进入
mutation 幂等缓存，也不应被客户端自动重试。`turn.start` 的输入在 v1 仅支持：

```json
{ "text": "用户消息" }
```

## Snapshot

`thread.snapshot` 返回：

```text
ThreadSummary
messages.items[]            UiMessage
messages.nextBeforeSequence
operations.items[]          OperationView
operations.nextBeforeSequence
activeTurn?
pendingApprovals[]
pendingInteractions[]        1.3/1.2；必需字段，可为空
eventCursor                  仅 1.3；必需字段，可为 null
transcriptCompleteness      complete | legacy_snapshot
```

`pendingInteractions` 同时存在于 1.3 与 1.2；`eventCursor` 只存在于 1.3。1.2/1.1/1.0
adapter 会剥离 `eventCursor` 与所有 1.3 event envelope 字段。

1.3/1.2 的 `activeTurn.status` 为 `running | cancelling | waiting-for-user`；冻结的 1.1/1.0
形状只接受 `running | cancelling`。向旧 wire 投影时，`waiting-for-user` 会兼容映射为
`running`，而不是把未知 enum 值泄漏给旧 Client。

`pendingInteractions` 是当前 responder 已 ACK、且对该 Thread 仍未结算的 Interaction 安全
投影。Approval 项严格只有：

```text
method = approval.request
interactionId
threadId
turnId
expiresAt
sensitivity = normal
approvalId
```

JSON-RPC `id`、Approval `preview`、原始 payload/result 与 secret 不会进入该投影。
User Input 项包含相同 Interaction metadata 与安全表单字段（title、description、controls、
choice options），但不包含完整 Result 或任何提交值。1.1/1.0 的 `thread.open`、
`thread.snapshot` 会完全剥离 `pendingInteractions`。1.3/1.2 Interaction 若缺少 Runtime 提供的
绝对 `expiresAt`，则 fail-closed，不会临时伪造 deadline。

消息与 Operation 使用独立游标。首页返回最近一页，但页内保持时间正序；下一页把
`nextBeforeSequence` 原样传回对应的 `messageBeforeSequence` 或
`operationBeforeSequence`。`thread.list`、`thread.open` 和 `thread.snapshot` 默认页大小
均为 `100`；显式 `limit` 的有效范围是 `1..500`，且不能超过初始化协商得到的
`limits.maxPageSize`。

Snapshot 的持久数据源是追加式 transcript 与 Tool ledger，因此不会因模型上下文压缩而
丢失新格式 Thread 的历史；但单次响应始终是分页结果。只有分别遍历 messages 与
operations 的所有页面后，才能称为恢复了可用的完整历史。

`OperationView` 不含 Tool `input`、`raw`、Provider metadata 或原始 evidence。Tool
展示值也会经过字段级 secret 清理和大小限制。`operation.get` 在 Operation ID 不存在时
返回 `{ "operation": null }`；Thread 本身不存在时仍返回 `THREAD_NOT_FOUND`。

## 事件

所有事件通过完整的 JSON-RPC Notification 发送。1.3 envelope 显式区分 durable 与
ephemeral；两者仍保留进程内 `sequence`，但只有 durable event 具有可恢复身份：

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.event",
  "params": {
    "protocolVersion": "1.3",
    "runtimeInstanceId": "uuid",
    "sequence": 0,
    "timestamp": "2026-07-28T12:00:00.000Z",
    "threadId": "uuid",
    "turnId": "uuid",
    "durability": "durable",
    "eventId": "uuid",
    "cursor": "rte1:00000000-0000-4000-8000-000000000101:0:00000000-0000-4000-8000-000000000102",
    "event": { "type": "turn.started" }
  }
}
```

`params.turnId` 在 Schema 中可选。UI 结束活动 Turn、清理 waiter 或刷新 Snapshot 时，必须
同时匹配目标 `threadId + turnId`，不能把其他 Thread 或旧 Turn 的终止事件当作当前结果。

| 1.3 durability | event allowlist | 恢复语义 |
|---|---|---|
| `durable` | `turn.started`、`message.completed`、`tool.completed`、`approval.required`、`approval.resolved`、`turn.completed`、`turn.cancelled`、`turn.failed`、`capabilities.changed` | 先事务提交事件日志，再发布 live；携带 `eventId` 与 `cursor`，可重放 |
| `ephemeral` | `message.started`、`message.delta`、`reasoning.summary.delta`、`tool.started`、`tool.output` | 只有进程内 `sequence`；没有 `eventId`/`cursor`，不承诺重放 |

`approval.required` 在 `"1.0"` 是控制事件；在 1.3/1.2/1.1 仅为只读 View Event。
Raw model reasoning、Token/reasoning/tool-output delta、原始 Tool input/evidence、
compaction/debug 事件和 AI SDK `ModelMessage` 都不会进入 durable 日志。Store 提交失败时，
Runtime 不得发布一个无法恢复的 durable live event。

### 持久事件恢复（1.3）

`runtime.events.resume` 只在 1.3 可用。`afterCursor` 是该 Thread 已应用的 checkpoint；首次从
原始日志起点恢复时传 `null`。`null` 不表示“当前最早保留事件”：如果原始日志前缀已经被
裁剪，Runtime 必须返回 `EVENT_CURSOR_EXPIRED`，调用方先用 `thread.snapshot` 收敛。Runtime
使用专用、无副作用的 replay 发送路径逐条发送
`runtime.event`，随后才返回：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "throughCursor": "rte1:00000000-0000-4000-8000-000000000101:42:00000000-0000-4000-8000-000000000142",
    "replayedCount": 3
  }
}
```

Response 是 replay→live barrier，顺序固定为：

```text
开始暂存该 Thread 的并发 live durable event
  → replay notifications
  → runtime.events.resume response
  → 按 cursor 排序、按 eventId 去重后释放暂存的 live event
```

Client 不得在 Response 前把并发 live event 越过 replay 投递给业务层。Replay 只能恢复安全
投影，不能重新触发 Approval、User Input、Tool、Turn 或其他副作用；ephemeral event 永不
重放。`@roll-agent/client-node` 的 `createEventRecovery().resumeThread()` 封装了 Snapshot、
暂存、排序、去重和 barrier 校验，默认恢复暂存窗口为 10,000 条 / 32 MiB。

Snapshot fallback 必须使用
`thread.snapshot({ threadId, limit: 1, recovery: true })`。1.3 Response 带
`recoveryProjection: true`，只保留安全的 Thread/checkpoint/active Turn 元数据，并将 messages、
operations、pending Approvals、pending Interactions 置为空；这样即使普通 Snapshot 同时含有大型
消息和大型审批预览，恢复 checkpoint 也始终可装入 17 MiB Client 帧。该投影不是完整 timeline，
Client 应在恢复完成后用普通 Snapshot 分页补载；typed Server Request 是未决 Interaction 的
权威来源。1.2/1.1/1.0 strict 参数 Schema 不接受 `recovery`，结果 Schema 也不包含该标记。

每个 Thread 首版最多保留 10,000 条、16 MiB、30 天，只裁剪最老的连续前缀。若
`afterCursor` 已被裁剪，或传入 `null` 时原始日志前缀已经被裁剪，Runtime 返回
`EVENT_CURSOR_EXPIRED`；若 cursor 不属于该 Thread
的连续日志，返回 `EVENT_CURSOR_GAP`。两者都要求 Client 丢弃旧 checkpoint，重新读取
`thread.snapshot` 的 `eventCursor` 后收敛；检测到新的 `runtimeInstanceId`、cursor 冲突、
本地暂存溢出或 replay/live gap 时也必须走 Snapshot fallback。1.2/1.1/1.0 仍只支持
Snapshot 恢复。

## Runtime → Client Server Request

`"1.3"`、`"1.2"` 与 `"1.1"` 的 Approval 只有一条可写控制路径：Runtime 发出
`approval.request`，Client 用同一个 JSON-RPC `id` 返回结果。`approval.required`
仍可用于渲染审批卡片或观察 pending 状态，但 Client 不得据此调用
`approval.respond`；在这三个版本上调用该方法会返回 `CAPABILITY_UNAVAILABLE`。
1.3/1.2 还要求 `approval.request` 已出现在最近一次 ACK 的 capability 集合中。
1.3/1.2 的 User Input 同样只有 `userInput.request` Result 这一条写入路径，并要求该 method
已出现在最近一次 ACK 中；没有 Handler 时 Runtime 不会把内建 `roll__user_input` Tool 暴露
给模型。

Runtime 会先登记并发送 `approval.request`，再发送对应的只读 `approval.required`
projection，避免 UI 快速响应时控制请求尚未存在。Client 仍应以 Server Request handler
为唯一决策入口，而不是依赖两条消息的相邻顺序维护业务状态机。

1.3/1.2 Runtime Request：

```json
{
  "jsonrpc": "2.0",
  "id": "runtime:uuid",
  "method": "approval.request",
  "params": {
    "interactionId": "uuid",
    "threadId": "uuid",
    "turnId": "uuid",
    "expiresAt": "2026-07-29T12:10:00.000Z",
    "sensitivity": "normal",
    "approval": {
      "id": "uuid",
      "turnId": "uuid",
      "agentName": "browser-use-agent",
      "toolName": "click",
      "preview": { "selector": "#submit" },
      "reason": "此操作会提交表单"
    }
  }
}
```

`turnId` 必须与 `approval.turnId` 相同。首版只允许
`sensitivity: "normal"`；`expiresAt` 是绝对截止时间，显式重投不会延长它。1.1 wire
形状保持冻结：

```json
{
  "threadId": "uuid",
  "approval": {
    "id": "uuid",
    "turnId": "uuid",
    "agentName": "browser-use-agent",
    "toolName": "click",
    "preview": { "selector": "#submit" },
    "reason": "此操作会提交表单"
  },
  "expiresAt": "2026-07-29T12:10:00.000Z"
}
```

其中 1.1 `expiresAt` 仍可省略，且没有 `interactionId`、顶层 `turnId` 或
`sensitivity`。1.0 不发送 Server Request，继续使用 `approval.required` +
`approval.respond`。

### User Input 1.3/1.2

`userInput.request` Params 使用相同 Interaction metadata，并携带 1..16 个结构化 control：

```json
{
  "interactionId": "uuid",
  "threadId": "uuid",
  "turnId": "uuid",
  "expiresAt": "2026-07-29T12:10:00.000Z",
  "sensitivity": "normal",
  "title": "配置部署目标",
  "controls": [
    {
      "type": "choice",
      "id": "region",
      "label": "部署区域",
      "required": true,
      "multiple": false,
      "options": [{ "id": "east", "label": "东区" }]
    },
    {
      "type": "text",
      "id": "workspace",
      "label": "目标 Workspace",
      "required": true,
      "maxLength": 120
    }
  ]
}
```

control 类型固定为 `text | multiline | number | boolean | choice`。control ID 最长 64、
label 最长 200、description 最长 500；choice 最多 50 个稳定 ID option，文本绝对上限
10,000 字符。首版只允许 `sensitivity: "normal"`，不定义 password、token、secret、
authentication 或 file-picker 字段。

提交与正常取消结果分别为：

```json
{ "status": "submitted", "values": [{ "id": "workspace", "value": "product-docs" }] }
```

```json
{ "status": "cancelled", "reason": "用户关闭了表单" }
```

Runtime 必须结合原始 Params 二次校验必填项、类型、未知/重复 ID、choice option 与数量边界，
再按 control 定义顺序规范化。等待期间 1.3/1.2 Snapshot 使用 `waiting-for-user`，默认 deadline
为 5 分钟或 Turn 剩余期限中的较小值；旧协议投影仍为 `running`。Result 只返回当前 Tool
调用，完整值不会进入 Runtime Event 或 Snapshot。

批准与拒绝都是成功的业务结果：

```json
{ "jsonrpc": "2.0", "id": "runtime:uuid", "result": { "decision": "approve" } }
```

```json
{
  "jsonrpc": "2.0",
  "id": "runtime:uuid",
  "result": { "decision": "reject", "reason": "用户取消" }
}
```

Handler 不存在时返回 `-32601`，参数非法时返回 `-32602`，Handler 抛错或返回非法结果时
返回 `-32603`。Runtime 对 Client error 或非法结果采取 fail-closed：先把 Approval 收敛为
`cancelled`，再以 `turn.failed` 结束 Turn；它不会默认批准，也不会伪装成用户主动拒绝。

JSON-RPC `id` 只负责当前投递的 Request/Response 关联；1.3/1.2 `interactionId` 负责逻辑
Interaction；`approval.id` 是跨 View、Snapshot 和审计使用的业务 ID。三者与 mutation
`requestId` 均不能互换。

### 取消与最终状态

Turn 取消、Turn 终止、deadline、capability 撤销或 Runtime 关闭时，Runtime 会尽力发送。
1.3/1.2 形状是：

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.serverRequest.cancel",
  "params": {
    "interactionId": "uuid",
    "reason": "Turn 已由客户端取消"
  }
}
```

1.1 形状原样保留：

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.serverRequest.cancel",
  "params": {
    "serverRequestId": "runtime:uuid",
    "approvalId": "uuid",
    "reason": "Turn 已由客户端取消"
  }
}
```

Client 必须终止对应的本地交互，且不得在取消后发送迟到 Response。合法决议完成后，或请求
因错误、取消而失效后，Runtime 用 `approval.resolved` 收敛当前 View：

```json
{
  "type": "approval.resolved",
  "approvalId": "uuid",
  "resolution": {
    "status": "resolved",
    "decision": "reject",
    "reason": "用户取消"
  }
}
```

`resolution` 的稳定形态为：

- `{ status: "resolved", decision: "approve" }`
- `{ status: "resolved", decision: "reject", reason? }`
- `{ status: "cancelled", reason }`
- `{ status: "expired", reason? }`

`"1.0"` 不发送 `approval.resolved`。人的审批与 User Input 不使用普通 Client `30s` RPC timeout；
生命周期由 `expiresAt`、Response、显式取消、Turn 终态、capability 撤销或连接关闭控制。

当前 `stdio` Transport 是单连接、进程绑定的边界。一个 `RuntimeService` 只接受一个
活动 `RuntimeProtocolAdapter` 控制连接；第二个 Adapter 会被拒绝，而不是竞相处理同一
Interaction。1.3 的事件恢复不会重放 Server Request；断线后没有持久 Interaction
replay/resume，未决 Server Request 会被取消，Runtime
随关闭流程 fail-closed 结束 Session。Client 重新启动后必须读取 Snapshot 收敛，不能
重投旧 JSON-RPC `id`。

Runtime 内部 Coordinator 跟踪当前进程内的 pending Interaction，并校验
`interactionId + JSON-RPC id + eligible responder + runtimeInstanceId`。显式重投生成新
JSON-RPC `id`，但复用原 `interactionId` 和 deadline。连接断开会取消该 responder 的
全部未决 Interaction；Coordinator 不承诺持久 `seq/ack/resume`、跨进程 responder
恢复或任意连接 first-wins。

这条 wire 路径不改变 `roll chat` TUI。TUI 仍在进程内通过既有 `clack` 选择式确认与
`AgentSession` 交互，不经过 Runtime Protocol Server Request。

## 错误

JSON-RPC 标准错误：

| code | 含义 |
|---:|---|
| `-32700` | Parse error |
| `-32600` | Invalid Request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |

Roll 领域错误使用 `error.data`：

```json
{
  "rollCode": "THREAD_NOT_FOUND",
  "retryable": false
}
```

Runtime 领域错误的外层 JSON-RPC `error.code` 为 `-32000`；参数 Schema 校验失败使用
`-32602`，并附带 `rollCode: "INVALID_PARAMS"`。稳定 `rollCode` 为：

| `rollCode` | 含义 |
|---|---|
| `PROTOCOL_VERSION_UNSUPPORTED` | 没有共同协议版本 |
| `INITIALIZE_REQUIRED` | v1 方法调用前尚未初始化 |
| `INVALID_PARAMS` | 参数或幂等 ID 使用冲突 |
| `THREAD_NOT_FOUND` | Thread 不存在 |
| `THREAD_BUSY` | Thread 当前不能执行该操作 |
| `TURN_NOT_FOUND` | Turn 不存在或已结束 |
| `TURN_ALREADY_ACTIVE` | Thread 已有活动 Turn |
| `APPROVAL_NOT_FOUND` | Approval 不存在或已失效 |
| `CAPABILITY_UNAVAILABLE` | 当前 Runtime 不支持所需能力 |
| `CAPABILITY_REVISION_CONFLICT` | 1.3/1.2 capability revision 过旧，或同 revision 配不同集合 |
| `EVENT_CURSOR_EXPIRED` | 1.3 checkpoint 已被连续前缀裁剪；重新读取 Snapshot |
| `EVENT_CURSOR_GAP` | 1.3 cursor 不属于可连续恢复的 Thread 日志；重新读取 Snapshot |
| `RUNTIME_CLOSING` | Runtime 正在关闭 |
| `OUTCOME_UNKNOWN` | 副作用结果无法确认 |
| `INTERNAL_ERROR` | 未分类内部错误 |

合法 JSON-RPC 错误的 `id` 可能是 `null`。这类错误无法关联到任一挂起请求，客户端不得猜测
归属；`@roll-agent/client-node` 会将其视为 `RollUncorrelatedRpcError` 并关闭连接。
Runtime 收到 Client 的 `id: null` Error 时同样会拒绝全部未决 Server Request 并关闭
连接，确保 Approval fail-closed，而不是无限等待人工决定。

## 幂等与未知结果

- `"1.0"` 进入 mutation 幂等缓存的七个方法是 `thread.create`、`thread.rename`、
  `thread.delete`、`thread.detach`、`turn.start`、`turn.cancel` 和
  `approval.respond`；`"1.3"` / `"1.2"` / `"1.1"` 不使用最后一个方法。上述 mutation 都携带 UUID
  `requestId`；
- 同一 `runtimeInstanceId` 内，最近 `limits.idempotencyCacheEntries` 个已完成 mutation
  会缓存其成功或失败结果；相同 `requestId` + 相同参数在该窗口内返回同一结果；
- 执行中的 mutation 单独保留，不占用已完成结果的容量，也不会为了满足上限而被淘汰；
- `turn.start` 还使用客户端生成的 `turnId` 去重：活动 Turn 始终保留，最近
  `limits.idempotencyCacheEntries` 个已完成 Turn 使用独立 LRU 窗口保留；
- 保留窗口内，相同 `requestId` 被用于不同方法或参数时返回 `INVALID_PARAMS`；
- 客户端必须为每次新的 mutation 生成全新 `requestId`，不得在窗口淘汰后重用旧 ID；
- 客户端必须为每个逻辑 Turn 生成全新 `turnId`；已完成 Turn 被淘汰后，Runtime
  不再保证旧 `turnId` 的去重；
- Runtime 退出后，客户端不得自动重放未确认结果的副作用命令。

Node 客户端默认只对服务端明确标记为 `retryable` 的只读请求重试一次，其中不包含
`thread.open`。它不自动重试副作用请求，并把连接失败时仍活动或写入结果不明确的 Turn
标记为 `outcome unknown`。UI 应停止本地 Working 状态、保留已显示内容、不自动重放，
然后在健康连接上或重连后通过 Snapshot 收敛。

请求超时、帧限制、错误类、`onExit()` 语义以及
stdin close → SIGTERM → SIGKILL 的有界关闭流程，见
[`@roll-agent/client-node` API 参考](./client-node-reference.md)。
