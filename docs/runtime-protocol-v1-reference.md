# Roll Runtime Protocol v1 参考

## 版本与入口

| 项目 | 值 |
|---|---|
| 最新 Wire protocol | `"1.1"` |
| 兼容 Wire protocol | `"1.0"` |
| 正式命令 | `roll runtime serve --stdio` |
| 兼容命令 | `roll chat --server` |
| Event notification | `runtime.event` |
| Server Request cancel notification | `runtime.serverRequest.cancel` |
| 分帧 | NDJSON，一行一个 JSON-RPC 消息 |
| 默认本地单帧上限 | `4 MiB`；初始化后以协商值为准 |
| Event replay | 不支持 |

Schema 单一数据源位于 `@roll-agent/protocol`。构建后可读取
`@roll-agent/protocol/schema` 的 JSON Schema Draft 2020-12 根 Schema；其 `$defs`
包含各方法 params/result/request、Server Request 以及 JSON-RPC response/event
定义；`x-roll-methods` 和 `x-roll-server-request-methods` 提供代码生成索引。
跨语言 fixture 位于 `@roll-agent/protocol/fixtures/v1/*`。

TypeScript 宿主可直接从包根导入：

- `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`RUNTIME_PROTOCOL_VERSION`、
  `RUNTIME_METHODS`、`RUNTIME_SERVER_REQUEST_METHODS`、
  `RUNTIME_PROTOCOL_CAPABILITIES`、`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION`、
  `RUNTIME_ERROR_CODES`；
- `getRuntimeProtocolCapabilities()`、`isRuntimeServerRequestMethodRequired()`；
- `runtimeMethodSchemas`、`parseRuntimeMethodParams()`、`parseRuntimeMethodResult()`；
- `runtimeServerRequestSchemas`、`parseRuntimeServerRequestParams()`、
  `parseRuntimeServerRequestResult()`；
- `runtimeEventEnvelopeSchema` 及各领域 Schema；
- `RuntimeMethodInput<TMethod>`、`RuntimeMethodParams<TMethod>`、
  `RuntimeMethodResult<TMethod>`；
- `RuntimeServerRequestInput<TMethod>`、`RuntimeServerRequestParams<TMethod>`、
  `RuntimeServerRequestResult<TMethod>`；
- `ThreadSnapshot`、`RuntimeEventEnvelope` 等 DTO 类型。

`@roll-agent/protocol` 只定义协议、Schema 和类型，不负责启动 Runtime 或管理连接。Node
进程生命周期由 [`@roll-agent/client-node`](./client-node-reference.md) 负责；远程
Web 接入使用由
[`@roll-agent/relay-protocol`](./companion-relay-v1-reference.md) 定义的独立 Relay v1
协议，并由用户本机 `@roll-agent/companion` Host 转接到 Runtime。

`RUNTIME_PROTOCOL_VERSION` 表示当前包提供的**最新 wire schema 版本**，适合 Server 默认值、
Schema 生成与 fixture 标注；它不表示任意调用方已经实现该版本要求的入站能力。直接使用
`@roll-agent/protocol` 的 Client 升级依赖后，必须审查新增的 Runtime→Client Request 与
Notification，并只在 `initialize.protocolVersions` 中广告自己确实实现的版本。
`RollNodeClient` 会根据初始化时注册的 handler 自动完成这一步。

## 初始化

客户端必须首先且仅调用一次 `initialize`：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersions": ["1.1", "1.0"],
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
| `eventReplay` | `false` | Runtime 不提供持久事件重放 |
| `idempotencyCacheEntries` | `10,000` | 已完成 mutation 的进程内缓存窗口 |

这些值是协商结果，不应在客户端写死。旧 `session.*` RPC 在兼容期内不要求 v1 初始化。

Runtime 按客户端 `protocolVersions` 的顺序选择第一个双方支持的版本：

| Client 能力 | 广告版本 | 新 Runtime 协商结果 | Approval 控制路径 |
|---|---|---|---|
| 已注册 `approval.request` handler | `["1.1","1.0"]` | `"1.1"` | Server Request |
| 未注册 Server Request handler | `["1.0"]` | `"1.0"` | Event + `approval.respond` |
| 旧 Client | `["1.0"]` | `"1.0"` | Event + `approval.respond` |
| 无共同版本 | 例如 `["2.0"]` | `PROTOCOL_VERSION_UNSUPPORTED` | 不建立协议会话 |

版本能力表由 `RUNTIME_PROTOCOL_CAPABILITIES` 提供：

| 字段 | `"1.1"` | `"1.0"` |
|---|---|---|
| `serverRequests` | `true` | `false` |
| `approvalResolvedEvents` | `true` | `false` |
| `clientApprovalResponses` | `false` | `true` |
| `requiredServerRequestMethods` | `["approval.request"]` | `[]` |

新 Client 向旧 Runtime 发送 `["1.1","1.0"]` 时，旧 Runtime 仍可选择 `"1.0"`。
协商结果属于当前连接；Client 不能在 `"1.0"` 连接上动态开启 `"1.1"` Server Request。
`@roll-agent/client-node` 只有在注册表覆盖目标版本的全部必需 Server Request handler 时
才广告该版本；`"1.1"` 当前唯一必需方法是 `approval.request`。
同一连接重复调用 `initialize` 会返回 `CAPABILITY_UNAVAILABLE`，且不会改变已经固定的
协议版本与控制路径。

`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION` 只描述某个 wire 版本的**必需**
Client handler，是从上述能力表派生的兼容导出，不是无限扩展的 UI 能力注册表。未来的
文件选择器、OAuth 或自由输入若是可选能力，应先定义独立的 Client capability 协商；若
变成所有 Client 都必须实现的 Request，则应升级协议版本，不能把它静默追加到既有
`"1.1"` 的必需方法中。

第一次调用 Runtime Protocol 方法或 legacy `session.*` 方法后，连接会锁定对应协议家族。
同一连接不能混用两套方法；例如完成 `initialize` 后调用 `session.approve` 会返回
`CAPABILITY_UNAVAILABLE`。这个边界防止 `"1.1"` Approval 绕过 Server Request 控制路径。

## ID 类型

| 字段 | Wire 类型 | 约束 |
|---|---|---|
| JSON-RPC `id` | `string` 或 `number` | 请求/响应关联；错误响应还可能为 `null` |
| cancel `serverRequestId` | `string` 或 `number` | 被取消的 Runtime→Client JSON-RPC `id` |
| `threadId`, `turnId`, `approvalId` | `string` | UUID |
| `runtimeInstanceId`, `requestId` | `string` | UUID |
| `streamId`, `operationId` | `string` | UUID |
| `toolCallId`, `reasoningId` | `string` | 非空字符串，不保证 UUID |
| `thread.list.cursor` | `string` | 十进制数字字符串 |
| Snapshot `*BeforeSequence` | `number` | 非负整数 |

Approval 链路必须分开三类身份：

- JSON-RPC `id` 只标识当前连接上的一次 Server Request 投递；
- cancel `serverRequestId` 原样引用上述 JSON-RPC `id`，不是 UUID mutation ID；
- `approvalId` 标识完整业务生命周期，可出现在 Snapshot、View Event 与取消通知中；
- mutation `requestId` 只用于 Client → Runtime 写操作幂等，不参与 Server Request 响应。

当前 stdio 协议断线即取消，不定义跨连接 Request 重投或恢复。

## 方法

| 方法 | 分类 | 关键输入 | 输出 |
|---|---|---|---|
| `initialize` | 握手 | 版本列表、客户端信息 | 版本、实例、features、limits |
| `thread.list` | 只读 | `cursor?`, `limit?` | Thread 分页 |
| `thread.create` | mutation | `requestId`, `title?` | `ThreadSummary` |
| `thread.open` | 附着/恢复 | `threadId` | `ThreadSnapshot` |
| `thread.snapshot` | 只读 | 两个独立 before sequence、`limit?` | `ThreadSnapshot` |
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
transcriptCompleteness      complete | legacy_snapshot
```

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

所有事件通过完整的 JSON-RPC Notification 发送：

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.event",
  "params": {
    "protocolVersion": "1.1",
    "runtimeInstanceId": "uuid",
    "sequence": 0,
    "timestamp": "2026-07-28T12:00:00.000Z",
    "threadId": "uuid",
    "turnId": "uuid",
    "event": { "type": "turn.started" }
  }
}
```

`params.turnId` 在 Schema 中可选。UI 结束活动 Turn、清理 waiter 或刷新 Snapshot 时，必须
同时匹配目标 `threadId + turnId`，不能把其他 Thread 或旧 Turn 的终止事件当作当前结果。
`params.sequence` 仅在当前 `runtimeInstanceId` 内单调递增，不是持久 replay cursor。

事件类型：

- `turn.started`
- `message.started`
- `message.delta`
- `message.completed`
- `reasoning.summary.delta`（仅 host 提供安全 summary projector 时启用）
- `tool.started`
- `tool.output`
- `tool.completed`
- `approval.required`（`"1.0"` 为控制事件；`"1.1"` 仅为只读 View Event）
- `approval.resolved`（仅 `"1.1"`）
- `turn.completed`
- `turn.cancelled`
- `turn.failed`
- `capabilities.changed`

Raw model reasoning、compaction/debug 事件和 AI SDK `ModelMessage` 不进入公共协议。

## Runtime → Client Server Request

`"1.1"` 的 Approval 只有一条可写控制路径：Runtime 发出 `approval.request`，Client 用同一个
JSON-RPC `id` 返回结果。`approval.required` 仍可用于渲染审批卡片或观察 pending 状态，但
Client 不得据此调用 `approval.respond`；在 `"1.1"` 上调用该方法会返回
`CAPABILITY_UNAVAILABLE`。

Runtime 会先登记并发送 `approval.request`，再发送对应的只读 `approval.required`
projection，避免 UI 快速响应时控制请求尚未存在。Client 仍应以 Server Request handler
为唯一决策入口，而不是依赖两条消息的相邻顺序维护业务状态机。

Runtime Request：

```json
{
  "jsonrpc": "2.0",
  "id": "runtime:uuid",
  "method": "approval.request",
  "params": {
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
}
```

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

JSON-RPC `id` 只负责当前连接上的 Request/Response 关联；`approval.id` 是跨 View、
Snapshot 和审计使用的业务 ID，两者不能互换。`expiresAt` 是可选的绝对时间；当前本地
Runtime 不设置通用审批 deadline，而是由 Turn/连接生命周期结束请求。

### 取消与最终状态

Turn 取消、Turn 终止或 Runtime 关闭时，Runtime 会尽力发送：

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

`"1.0"` 不发送 `approval.resolved`。人的审批没有通用 `30s` RPC timeout；生命周期由
Response、显式取消、Turn 终态或连接关闭控制。

当前 `stdio` Transport 是单连接、进程绑定的边界。一个 `RuntimeService` 只接受一个
活动 `RuntimeProtocolAdapter` 控制连接；第二个 Adapter 会被拒绝，而不是竞相处理同一
Approval。断线后没有 Request replay/resume，未决 Server Request 会被取消，Runtime
随关闭流程 fail-closed 结束 Session。Client 重新启动后必须读取 Snapshot 收敛，不能
重投旧 JSON-RPC `id`。

Runtime 内部 Coordinator 只跟踪当前进程、当前连接上的 pending Request，并校验
`JSON-RPC id + responder identity + runtimeInstanceId`。连接断开会取消该 responder 的
全部未决 Request；Coordinator 不保留可供重投的数据，也不承诺持久
`seq/ack/resume`、跨进程 responder 恢复或任意连接 first-wins。

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
  `approval.respond`；`"1.1"` 不使用最后一个方法。上述 mutation 都携带 UUID
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
