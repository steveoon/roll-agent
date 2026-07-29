# Roll Runtime Protocol v1 参考

## 版本与入口

| 项目 | 值 |
|---|---|
| Wire protocol | `"1.0"` |
| 正式命令 | `roll runtime serve --stdio` |
| 兼容命令 | `roll chat --server` |
| Event notification | `runtime.event` |
| 分帧 | NDJSON，一行一个 JSON-RPC 消息 |
| 默认本地单帧上限 | `4 MiB`；初始化后以协商值为准 |
| Event replay | 不支持 |

Schema 单一数据源位于 `@roll-agent/protocol`。构建后可读取
`@roll-agent/protocol/schema` 的 JSON Schema Draft 2020-12 根 Schema；其 `$defs`
包含各方法 params/result/request 以及 JSON-RPC response/event 定义，`x-roll-methods`
提供代码生成索引。跨语言 fixture 位于 `@roll-agent/protocol/fixtures/v1/*`。

TypeScript 宿主可直接从包根导入：

- `RUNTIME_PROTOCOL_VERSION`、`RUNTIME_METHODS`、`RUNTIME_ERROR_CODES`；
- `runtimeMethodSchemas`、`parseRuntimeMethodParams()`、`parseRuntimeMethodResult()`；
- `runtimeEventEnvelopeSchema` 及各领域 Schema；
- `RuntimeMethodInput<TMethod>`、`RuntimeMethodParams<TMethod>`、
  `RuntimeMethodResult<TMethod>`；
- `ThreadSnapshot`、`RuntimeEventEnvelope` 等 DTO 类型。

`@roll-agent/protocol` 只定义协议、Schema 和类型，不负责启动 Runtime 或管理连接。Node
进程生命周期由 [`@roll-agent/client-node`](./client-node-reference.md) 负责；远程
Companion 使用[独立的 Relay v1 协议](./companion-relay-v1-reference.md)。

## 初始化

客户端必须首先调用 `initialize`：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersions": ["1.0"],
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

## ID 类型

| 字段 | Wire 类型 | 约束 |
|---|---|---|
| JSON-RPC `id` | `string` 或 `number` | 请求/响应关联；错误响应还可能为 `null` |
| `threadId`, `turnId`, `approvalId` | `string` | UUID |
| `runtimeInstanceId`, `requestId` | `string` | UUID |
| `streamId`, `operationId` | `string` | UUID |
| `toolCallId`, `reasoningId` | `string` | 非空字符串，不保证 UUID |
| `thread.list.cursor` | `string` | 十进制数字字符串 |
| Snapshot `*BeforeSequence` | `number` | 非负整数 |

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
| `approval.respond` | mutation | `requestId`, IDs, decision | `{ resolved: true }` |
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
    "protocolVersion": "1.0",
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
- `approval.required`
- `turn.completed`
- `turn.cancelled`
- `turn.failed`
- `capabilities.changed`

Raw model reasoning、compaction/debug 事件和 AI SDK `ModelMessage` 不进入公共协议。

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

## 幂等与未知结果

- 进入 mutation 幂等缓存的七个方法是 `thread.create`、`thread.rename`、
  `thread.delete`、`thread.detach`、`turn.start`、`turn.cancel` 和
  `approval.respond`；它们都携带 UUID `requestId`；
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
