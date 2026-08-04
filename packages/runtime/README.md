# `@roll-agent/runtime`

`@roll-agent/runtime` 实现 Roll Runtime 的 Thread、Turn、Interaction、事件投影和持久存储。
第三方宿主应通过 `@roll-agent/client-node` 或版本化 Runtime Protocol 接入，不应直接依赖
`RuntimeService`、`ThreadStore` 等内部类。

## 协议版本

当前支持 Runtime Protocol `1.3`、`1.2`、`1.1`、`1.0`。1.3 在 1.2 typed Interaction
与 capability handshake 基础上增加 durable event 恢复；旧版本继续使用 Snapshot 收敛。

| 1.3 event | allowlist | 恢复 |
|---|---|---|
| durable | Turn 状态、完整消息、安全 Tool 完成投影、安全 Approval 状态、capability 变更 | 先事务提交后发布；携带 `eventId` 与不透明 Thread `cursor` |
| ephemeral | message/reasoning/tool-output delta 与开始态 | 仅进程内 `sequence`，不持久、不重放 |

1.3 Snapshot 包含可空 `eventCursor`。Client 使用
`runtime.events.resume({ threadId, afterCursor })` 后，Runtime 先逐条发送 replay
notification，再返回 `{ throughCursor, replayedCount }`；该 Response 是 replay→live
barrier。Client 必须暂存并发 live durable event，收到 Response 后按 cursor 排序、按
eventId 去重再交付。

每个 Thread 的事件日志最多保留 10,000 条、16 MiB、30 天，只裁剪最老连续前缀。
`afterCursor: null` 固定表示原始日志起点；若该起点已被裁剪，Runtime 返回
`EVENT_CURSOR_EXPIRED`，不会从当前最早保留事件静默续传。
`EVENT_CURSOR_EXPIRED`、`EVENT_CURSOR_GAP`、Runtime 重启或 Client 检测到 stream gap 时，
回退 `thread.snapshot({ threadId, limit: 1, recovery: true })`。该 1.3 响应携带
`recoveryProjection: true`，保留 checkpoint/active Turn 元数据并清空 timeline 与 pending
arrays，从而保证单帧可承载；完整 timeline 由普通 Snapshot 分页补载，未决 Interaction 以
当前连接的 Server Request 为权威。Replay 使用无副作用路径，不会重新触发 Approval、
User Input、Tool、Turn 或其他执行。

## 边界

- Runtime event cursor 按 Thread 标识 durable 日志；Relay `relaySequence`/ACK 按 Workspace
  标识安全投影投递。两者类型和生命周期不同，不能相互确认或推导。
- #176 不修改 Relay Wire，也不提供持久 Relay outbox、Interaction WAL 或 Server Request
  replay。断线仍会取消未决 Approval/User Input handler。
- `authentication.request` 与 File Picker 没有远程 projector，保持 local-only；未来远程
  启用必须先完成安全 RFC #186。

完整契约见：

- [Runtime Protocol v1 参考](../../docs/runtime-protocol-v1-reference.md)
- [`@roll-agent/client-node` API 参考](../../docs/client-node-reference.md)
- [Runtime Protocol 架构与边界](../../docs/runtime-protocol-architecture.md)
- [Relay 1.1/1.0 参考](../../docs/companion-relay-v1-reference.md)
