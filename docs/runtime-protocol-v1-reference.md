# Roll Runtime Protocol v1 参考

## 版本与入口

| 项目 | 值 |
|---|---|
| Wire protocol | `"1.0"` |
| 正式命令 | `roll runtime serve --stdio` |
| 兼容命令 | `roll chat --server` |
| Event notification | `runtime.event` |
| 分帧 | NDJSON，一行一个 JSON-RPC 消息 |
| 单帧上限 | `4 MiB` |
| Event replay | 不支持 |

Schema 单一数据源位于 `@roll-agent/protocol`。构建后可读取
`@roll-agent/protocol/schema` 的 JSON Schema Draft 2020-12 根 Schema；其 `$defs`
包含各方法 params/result/request 以及 JSON-RPC response/event 定义，`x-roll-methods`
提供代码生成索引。跨语言 fixture 位于 `@roll-agent/protocol/fixtures/v1/*`。

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
前必须遵守协商后的单帧上限。旧 `session.*` RPC 在兼容期内不要求 v1 初始化。

## 方法

| 方法 | 是否改变状态 | 关键输入 | 输出 |
|---|---:|---|---|
| `thread.list` | 否 | `cursor?`, `limit?` | Thread 分页 |
| `thread.create` | 是 | `requestId`, `title?` | `ThreadSummary` |
| `thread.open` | 附着活动 Session | `threadId` | `ThreadSnapshot` |
| `thread.snapshot` | 否 | 两个独立 before cursor、`limit?` | `ThreadSnapshot` |
| `thread.rename` | 是 | `requestId`, `threadId`, `title` | 更新后的 Thread |
| `thread.delete` | 是 | `requestId`, `threadId` | `deleted` |
| `thread.detach` | 是 | `requestId`, `threadId` | `detached` |
| `thread.capabilities` | 否 | `threadId` | 安全 Capability manifest |
| `turn.start` | 是 | `requestId`, `threadId`, `turnId`, 文本输入 | 立即返回 `accepted` |
| `turn.cancel` | 是 | `requestId`, `threadId`, `turnId` | `cancelling` |
| `approval.respond` | 是 | `requestId`, IDs, `approve` / `reject` | `resolved` |
| `operation.get` | 否 | `threadId`, `operationId` | 脱敏 Operation |

所有 ID 都是 UUID。`turn.start` 的输入在 v1 仅支持：

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
`operationBeforeSequence`。

`OperationView` 不含 Tool `input`、`raw`、Provider metadata 或原始 evidence。Tool
展示值也会经过字段级 secret 清理和大小限制。

## 事件

所有事件使用统一信封：

```json
{
  "protocolVersion": "1.0",
  "runtimeInstanceId": "uuid",
  "sequence": 0,
  "timestamp": "2026-07-28T12:00:00.000Z",
  "threadId": "uuid",
  "turnId": "uuid",
  "event": { "type": "turn.started" }
}
```

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

稳定 `rollCode` 包括版本不兼容、未初始化、Thread 不存在/繁忙、Turn 不存在/冲突、
Approval 失效、能力不可用、Runtime 关闭、结果未知和内部错误。

## 幂等与未知结果

- 所有改变状态的 v1 命令携带 UUID `requestId`；
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

`@roll-agent/client-node` 默认只对服务端明确标记为 `retryable` 的只读请求重试一次，
其中不包含会恢复/附着 Session 的 `thread.open`。它不自动重试副作用请求，并把退出时
仍活动的 Turn 标记为 `outcome unknown`。

客户端默认请求超时为 `30,000 ms`，可通过 `requestTimeoutMs` 调整。初始化失败会关闭
子进程；`getInitializationResult()` 返回协商结果，`onExit()` 只在 Runtime 真实退出或
有界终止最终失败后触发。出站超大帧会在写入前抛出 `RollRequestFrameTooLargeError`；
合法的 `id: null` JSON-RPC error 会作为 `RollUncorrelatedRpcError` 关闭连接。畸形 JSON、
非法 `runtime.event`、错误 data 或不符合方法 Schema 的 result 会触发
`RollProtocolViolationError`。所有连接级失败都会拒绝挂起请求，并继续执行
stdin close → SIGTERM → SIGKILL 的有界关闭流程。
