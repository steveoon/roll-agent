# `@roll-agent/relay-protocol` Relay 1.1/1.0 参考

## 边界

Companion Relay Protocol 连接 Cloud Relay 与用户本机 Companion；它与 Roll Runtime
Protocol 是两层独立协议。

```text
Browser ── Cloud Relay ── Companion Relay Protocol ── Local Companion
                                                      │
                                           Roll Runtime Protocol
                                                      │
                                                   Runtime
```

`@roll-agent/relay-protocol` 是 Browser、Cloud Relay 和 Local Companion 共享的 Browser-safe
Wire 契约来源，提供版本注册表、严格消息/方法 Schema、ID、JSON Schema、fixtures、reference
adapter 与 conformance suite。它不包含 Transport、账号、数据库、Policy 或部署代码。

`@roll-agent/companion` 消费该契约，提供本机 Host 侧 bridge、Workspace lease、Interaction
Broker、ACK/gap 缓冲、去重与出站重连。它不包含生产 Cloud Relay、Browser SDK、账号/设备
身份、controller 选举、鉴权授权、TLS、可靠投递、持久 outbox、Interaction WAL、HA、监控
或本地确认 UI。

| 组件 | 直接依赖 | 运行位置 |
|---|---|---|
| Browser Web App | `@roll-agent/relay-protocol` | 用户浏览器 |
| Cloud Relay Server | `@roll-agent/relay-protocol` | 云端 |
| Local Companion Host | `@roll-agent/companion`、`@roll-agent/client-node` | 用户本机 Node/Electron Main/daemon |
| Local-only Desktop GUI | `@roll-agent/client-node` | 用户本机；不需要 Companion |

安装任一 npm 包都不会隐式建立 Relay 连接。宿主必须显式完成认证与 Workspace 绑定，再启动
`OutboundCompanionRelayV11`（或旧的 V1.0 `OutboundCompanionRelay`）。

## 版本矩阵

`SUPPORTED_RELAY_PROTOCOL_VERSIONS` 固定为 `["1.1", "1.0"]`。

| Wire | Companion API | 远程交互 |
|---|---|---|
| `1.1` | `CompanionRelayBridgeV11.connect(transport, options)` | `interaction.request/resolved/cancelled` + `interaction.candidate` |
| `1.0` | `CompanionRelayBridge.connect(transport)` | 冻结的 Approval 专属路径 |

所有未带 `V11` 后缀的 legacy 通用 exports 都继续固定为 1.0。新 Companion 与旧 peer 使用 1.0
时不能发送 1.1 Interaction；1.0 registry、Schema 和 fixtures 不再扩张。

Wire version 与 npm package version、Runtime Protocol version 相互独立。本地 Runtime 1.2 的
字段不能直接偷渡进 Wire 1.0；每一层都必须按自己的 registry 解析和投影。

## Wire 1.1 消息

| 消息 `type` | 方向 | 用途 |
|---|---|---|
| `device.connect` | Companion → Relay | `protocolVersion: "1.1"`、设备 ID、pairing token |
| `runtime.request` | Relay → Companion | query/mutation 或 `interaction.candidate` |
| `runtime.response` | Companion → Relay | request 结果或稳定错误 |
| `runtime.event` | Companion → Relay | 安全 Runtime event 投影 |
| `interaction.request` | Companion → Relay | 安全的 Approval/User Input 请求投影 |
| `interaction.resolved` | Companion → Relay | 逻辑交互已完成；不携带完整 Result |
| `interaction.cancelled` | Companion → Relay | 逻辑交互已取消；不携带本地错误细节 |
| `runtime.ack` | Relay → Companion | 确认最高连续 `relaySequence` |
| `runtime.gap` | Companion → Relay | 缓冲缺口；回退 `thread.snapshot` |
| `runtime.encrypted` | 双向 | Workspace payload cipher 信封 |

`runtime.event` 和三类 Interaction 帧共享单个 Workspace `relaySequence`。ACK 只确认 Relay
投递前缀，不确认 Runtime event cursor。

### Typed Interaction

Wire 1.1 只支持两类远程 Interaction：

| `method` | request projection | candidate |
|---|---|---|
| `approval.request` | `approvalId/agentName/toolName/explanation?` | `{ decision: "approve" | "reject", reason? }` |
| `userInput.request` | title/description 与五类安全 form controls | submitted/cancelled User Input Result |

请求公共字段为 `interactionId/threadId/turnId/expiresAt/sensitivity`。当前只允许
`sensitivity: "normal"`。远端通过 mutation `interaction.candidate` 提交候选：

```json
{
  "type": "runtime.request",
  "requestId": "00000000-0000-4000-8000-000000000701",
  "workspaceId": "00000000-0000-4000-8000-000000000702",
  "method": "interaction.candidate",
  "params": {
    "interactionId": "00000000-0000-4000-8000-000000000703",
    "threadId": "00000000-0000-4000-8000-000000000704",
    "turnId": "00000000-0000-4000-8000-000000000705",
    "method": "approval.request",
    "candidate": { "decision": "approve" }
  }
}
```

`{ "accepted": true }` 只表示候选已由本机 Broker 接受并结算，不代表 Tool 已执行。
Browser 必须等待有序的 `interaction.resolved` 或 `interaction.cancelled` 收敛视图。

候选验证顺序为：

1. Wire Schema 先拒绝非法信封、未知 method 和畸形 candidate 外形。
2. Host 提供的 responder policy 验证当前认证会话/连接 generation 是否有资格响应。
3. Broker 对照 pending Interaction 与 Runtime 原始 Params 做 method-specific 二次校验；User
   Input 按 control 顺序规范化。
4. Approval approve 再经过本地 Approval Policy；reject 不扩大权限。

重复的同一 `workspaceId + requestId` 返回缓存结果；相同 ID 携带不同 method/params 返回
`RELAY_REQUEST_ID_CONFLICT`。Runtime cancel、Turn 终态、deadline、Workspace 解绑、bridge
关闭和重连 generation 失效都进入单次原子终止路径。旧 generation 的迟到候选不能结算。

### 安全边界

以下数据不得进入 Wire：

- Runtime JSON-RPC `id`；
- 原始 Tool input/output/evidence 与 secret；
- 完整 User Input Result；
- 本地授权状态、Policy 内部错误和确认凭据。

`interaction.resolved/cancelled` 只携带关联字段和 method，不携带完整 Result 或错误正文。
`approval.required` 等 Runtime timeline event 即使被安全投影，也只是只读时间线；远程响应必须
命中 Broker 当前 pending `interactionId`，不能从 timeline event 直接执行控制操作。

`authentication.request` 和 File Picker 没有 Wire 1.1 projector，也不注册 Runtime handlers，
保持 local-only。未来若要启用必须先完成安全 RFC #186。

## ID 与 cursor

| 标识或游标 | 生命周期 | 用途 |
|---|---|---|
| Runtime JSON-RPC `id` | 当前 Runtime 连接的一次投递 | Request/Response correlation |
| `interactionId` | 一次逻辑 Interaction 完整生命周期 | request/resolved/cancelled 与候选关联 |
| Relay `requestId` | 一次 Relay request 及其重投 | response correlation、冲突检测与缓存 |
| Runtime mutation `params.requestId` | 一次 Runtime 写操作 | Runtime 幂等键 |
| Relay `relaySequence` / ACK | 单 Workspace Relay 投递流 | 重投、ACK 与 gap |
| Runtime event cursor/sequence | Runtime event 流 | Runtime 自己的恢复语义 |

这些类型和值不能混用。Relay `requestId` 不能充当 `interactionId` 或 Runtime mutation
`requestId`；Relay ACK 也不能确认 Runtime event cursor。

## Companion 接线

```ts
const broker = new CompanionInteractionBroker();
const runtime = await RollNodeClient.start({
  cwd: workspacePath,
  serverRequestHandlers: createRuntimeServerRequestHandlers(broker),
});
const workspace = new CompanionWorkspace({
  client: runtime,
  workspaceId,
  interactionBroker: broker,
  localApprovalPolicy,
});
const bridge = new CompanionRelayBridgeV11({
  deviceId,
  pairingToken,
  workspaces: new Map([[workspaceId, workspace]]),
});

bridge.connect(authenticatedTransport, {
  responderContext: authenticatedSession,
  responderPolicy: ({ responderContext, signal }) =>
    authorizeResponder(responderContext, { signal }),
});
```

`responderContext` 是 Host-owned opaque state。Companion 不解释它，也不因其存在就提供生产
身份或 controller 选举。Protocol 1.2 Runtime 若未接入 Interaction Broker 会 fail closed；
不会通过 timeline event 猜测或回退成未授权响应。

`CompanionInteractionBroker` 持有 pending Interaction 与 lease：Approval 使用 `approval`
lease，User Input 复用其 Turn lease。它在 Runtime Handler 开始时发布 request，在 Result、
cancel、deadline、terminal Turn、绑定释放或 close 时只结算并释放一次。

旧的 `CompanionApprovalRequestBroker` 已 deprecated，保留一个 minor 周期支持 Wire 1.0。
旧 `CompanionRelayBridge.connect(transport)` 不接受 1.1 options，仍发送
`protocolVersion: "1.0"`。

## ACK、buffer 与重连

Wire 1.1 使用 `CompanionRelayFrameBuffer` 将安全 Runtime event 与 Interaction 帧放入同一
有序流。默认上限为 10,000 条 / 16 MiB，只保留进程内状态。

- ACK 不能超过当前 transport generation 已成功发送的最高连续 sequence。
- 重连使用新 generation 和独立发送队列，重投未 ACK 的帧。
- 缓冲前缀已裁剪时发送 `runtime.gap`，Browser 回退 `thread.snapshot`。
- generation 关闭会 abort 它提交中的候选；旧异步结果不会发送到新连接。
- bridge 的 `close()` 是终态，并终止仍 pending 的远程 Interaction。

这不是可靠 outbox、Interaction WAL 或持久 Runtime event log。Companion 进程重启后应重新
建立 Workspace 状态并用 Snapshot 收敛。

## Workspace payload cipher

Wire 1.1 使用 `RelayPayloadCipherV11`。配置 cipher 的 Workspace 只接受
`runtime.encrypted` request，response/event/interaction 也只以 encrypted envelope 发送。
Relay 仍可见 Workspace ID、payload kind、request ID 或 sequence 等路由元数据。

算法选择、AEAD、nonce 管理、密钥协商/轮换、Browser 实现和密钥存储均由宿主负责；
`decrypt()` 必须验证算法与信封元数据，而不只是解码 ciphertext。

## 出站连接与测试 fake

`OutboundCompanionRelayV11.connectTransport()` 每次重连返回：

```ts
{
  transport: RelayTransportV11;
  responderPolicy: RemoteInteractionResponderPolicy;
  responderContext: unknown;
}
```

这使 responder 权限与具体认证 generation 绑定。`start()` 启动指数退避；`stop()` 关闭当前
Transport 与 bridge，但 Runtime 生命周期仍由 Workspace Host 管理。

`createWebSocketRelayTransportV11()` 只是文本 JSON adapter。生产 Host 仍必须实现鉴权、
帧上限、心跳、日志和协议诊断。

`@roll-agent/companion/testing` 的 `InMemoryRelayTransportV11` 仅用于确定性测试候选、重复、
ACK、断线与迟到 generation。它不提供生产身份、鉴权、controller 选举、可靠投递、持久
outbox 或 WAL，不能作为生产 Transport。

## 相关文档

- [Runtime Protocol 架构与安全边界](./runtime-protocol-architecture.md)
- [使用自己的技术栈接入 Roll](./how-to-build-roll-runtime-ui.md)
- [`@roll-agent/client-node` API 参考](./client-node-reference.md)
