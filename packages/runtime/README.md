# `@roll-agent/runtime`

`@roll-agent/runtime` 实现 Roll 的通用对话执行内核，涵盖 `ConversationEngine`、`AgentSession`、`ThreadStore`、上下文压缩、权限审批、并发资源锁、定时调度账本（Scheduler）以及 `RuntimeService` 事件投影。

- **第一方宿主接线**：`@roll-agent/core` 通过 `./host-contracts`、`./tool-contracts`、`./skills` 等中立契约子路径注入配置、模型与 MCP 宿主能力；`Runtime` 不反向依赖 `Core`。
- **第三方客户端接入**：桌面端与外部应用应通过 [`@roll-agent/client-node`](../client-node/README.md) 或版本化 Runtime Protocol 接入，不应直接实例化 `RuntimeService` 或 `ThreadStore` 等内部类。

## 支持的协议版本

当前支持 Runtime Protocol `"1.6"`、`"1.5"`、`"1.4"`、`"1.3"`、`"1.2"`、`"1.1"`、`"1.0"`：

- **`1.6`**：新增项目会话浏览（`thread.browse`）、会话级模型列表与切换（`runtime.models.list` / `thread.model.get` / `thread.model.set`）、审批完整差异预览（`approval.preview`）、推理文本流式订阅（`reasoning.text.subscribe` / `reasoning.text.delta`）及旧版上下文恢复门禁状态（`contextRecovery` / `context.recovery.changed`）。
- **`1.5`**：新增有界结构化应用输出（`app-output` 描述符与只读拉取接口 `operation.result.get`）。
- **`1.4`**：新增会话附件分片暂存、提交与释放（`attachment.stage` / `chunk` / `commit` / `release`）。
- **`1.3`**：在 `1.2` 类型化交互（Interaction）与客户端能力版本号（capability revision）协商基础上，引入持久化事件（durable event）游标续传；`1.0–1.2` 继续通过普通 Snapshot 收敛状态。

| 1.3–1.6 事件类别 | 覆盖范围 | 持久化与恢复语义 |
| --- | --- | --- |
| `durable` | 轮次状态、完整消息、脱敏工具完成投影（1.5+ 含 `appOutput` 描述符）、审批状态、能力变更、1.6 `context.recovery.changed` | 先事务提交至会话事件日志再对外发布；携带独立 `eventId` 与不透明会话 `cursor` |
| `ephemeral` | 消息/思考摘要/工具输出增量（delta）、1.6 订阅后的 `reasoning.text.delta` 及开始态通知 | 仅带当前进程内递增 `sequence`，不落盘、不重放 |

### 事件续传与恢复快照（1.3–1.6）

1.3–1.6 的 Snapshot 包含可空的 `eventCursor`。客户端调用 `runtime.events.resume({ threadId, afterCursor })` 时，Runtime 先逐条重放持久化事件通知，最后返回 `{ throughCursor, replayedCount }` 作为“重放转实时”的分界屏障（barrier）。客户端须先暂存恢复期间并发到达的实时持久化事件，待收到该响应后按 `cursor` 排序、按 `eventId` 去重再统一交付。

每个会话的事件日志最多保留 `10,000` 条、`16 MiB` 或 `30` 天，仅按时间顺序裁剪最早的连续前缀。`afterCursor: null` 固定代表原始日志起点；若起点已被裁剪，Runtime 返回 `EVENT_CURSOR_EXPIRED`，不会静默从当前最早保留处续传。

遇到 `EVENT_CURSOR_EXPIRED`、`EVENT_CURSOR_GAP`、Runtime 重启或客户端检测到流缺口时，客户端应回退调用 `thread.snapshot({ threadId, limit: 1, recovery: true })`。该恢复响应带有 `recoveryProjection: true`，仅保留恢复游标、活动轮次及 1.6 `contextRecovery` 等轻量元数据，并将消息、操作历史与待处理交互数组置空，从而确保单帧体积可控；全量时间线需另行调用普通 Snapshot 分页读取，未决交互以当前连接收到的服务端请求（Server Request）为准。事件重放走无副作用专用路径，不会重新触发审批、用户输入或工具调用。

## 安全与传输边界

- **游标隔离**：Runtime 的 `eventCursor` 按单会话（Thread）标识本地持久化事件日志；Relay 的 `relaySequence` / ACK 按工作区（Workspace）标识远端脱敏投影投递。两者生命周期独立，不可混用或相互推导。
- **断线取消语义**：本地 stdio 与远端 Relay 连接均不包含跨进程未决服务端请求重放；连接断开会自动取消当前连接上挂起的审批或用户输入处理器。
- **仅限本地的敏感交互**：`authentication.request` 与本地文件选择器（File Picker）不提供远端投影器，始终保持本机专属（local-only）。

## 相关契约文档

- [Runtime Protocol v1 参考](../../docs/runtime-protocol-v1-reference.md)
- [`@roll-agent/client-node` API 参考](../../docs/client-node-reference.md)
- [Runtime Protocol 架构与边界](../../docs/runtime-protocol-architecture.md)
- [Companion Relay 协议参考](../../docs/companion-relay-v1-reference.md)
