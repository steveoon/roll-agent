# `@roll-agent/relay-protocol` Relay 1.3/1.2/1.1/1.0 参考

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

`@roll-agent/relay-protocol` 是 Cloud Relay、Browser Client 和 Local Companion 共享的
浏览器安全契约来源，提供版本注册表、严格消息/方法 Schema、ID、JSON Schema（`./schema/v1.3`、
`./schema/v1.2`、`./schema/v1.1`、`./schema/v1.0`）、fixtures（`./fixtures/v1.3/*`、`v1.2/*`、
`v1.1/*`、`v1/*`）、reference adapter 与 conformance suite。它不包含 Transport、账号、数据库、
策略或部署代码。普通 Web App 通过 `@roll-agent/relay-client` 间接消费该契约。

`@roll-agent/companion` 消费该契约，提供本机宿主侧桥接器、Workspace 租约、Interaction
Broker、本地审批与 `appOutput` 门禁策略、ACK/缺口帧缓冲、幂等去重与主动出站重连。它不包含生产级
Cloud Relay、Browser UI、账号/设备身份体系、控制权（controller）选举、鉴权授权、TLS、持久化
outbox、Interaction WAL、高可用、监控或电脑端确认弹窗 UI。

| 组件 | 直接依赖 | 运行位置 |
|---|---|---|
| Browser Web App | `@roll-agent/relay-client` | 用户浏览器 |
| Cloud Relay Server | `@roll-agent/relay-protocol` | 云端 |
| 官方 Local Companion Host | `roll companion`（Core 内部使用 `companion`、`client-node`） | 用户本机 per-user daemon |
| 高级自定义 Host | `@roll-agent/companion`、`@roll-agent/client-node` | 版本锁定的 Node/Electron Main |
| Local-only Desktop GUI | `@roll-agent/client-node` | 用户本机；不需要 Companion |

安装任一 npm 包都不会隐式建立 Relay 连接。官方宿主必须先完成设备注册（enrollment）与本机
Workspace 绑定；仅高级自定义宿主才直接装配 `OutboundCompanionRelayV11`。冻结的 Wire `1.0`
`OutboundCompanionRelay` 严禁用于面向公网的浏览器接入。

## Browser Control 1.0

Relay Wire `1.1–1.3` 承载对话与交互数据面，而 `@roll-agent/relay-protocol/control` 独立定义浏览器会话引导（bootstrap）控制面：

- `relaySessionDescriptorSchema` 校验第三方后端返回的 `wss:// connectUrl` 与 `expiresAt`；
- `session.ready` 必须是 Browser WSS 收到的第一帧，固定 `controlVersion: "1.0"`，其 `relayProtocolVersion` 支持 `"1.1"`、`"1.2"` 或 `"1.3"`（包内同时导出固定 `"1.1"` 的 `relaySessionReadyControlMessageSchema` / `parseRelayBrowserFirstControlFrame()`，以及兼容 `1.1–1.3` 的 `relaySessionReadyControlMessageSchemaV12`、`relaySessionReadyControlMessageSchemaV13`、`relaySessionReadyControlMessageSchemaAny`、`relayBrowserControlMessageSchemaAny` 与 `parseRelayBrowserFirstControlFrameAny()`）；
- `workspace.status` 表示本机 Companion / Runtime 当前为 `online` 或 `offline`；
- `session.error` 仅携带稳定错误码 `code` 与 `retryable`；
- Browser → Relay 仅允许发送 `runtime.request` 与 `runtime.ack`；Relay → Browser 仅允许下发上述三类 Control 帧，以及 `runtime.response`、`runtime.event`、`runtime.gap` 与三类 Interaction 数据面帧；
- 当前 P0 浏览器方向白名单明确排除 `runtime.encrypted`（尚未交付浏览器侧端到端密钥协商）。

Control 消息不属于 `relayMessageSchemaV11` / `V12` / `V13`，Cloud Relay 必须按连接角色与收发方向分别校验。
远程脱敏后的 Snapshot 不包含可响应的 `interactionId`；当浏览器新建或替换会话时，Cloud Relay 必须保留并重投尚未 `resolved` / `cancelled` 的 `interaction.request`，前端不能从 `approvalId` 反推或伪造 `interactionId`。

## 版本矩阵

`SUPPORTED_RELAY_PROTOCOL_VERSIONS` 为 `["1.3", "1.2", "1.1", "1.0"]`，`LATEST_RELAY_PROTOCOL_VERSION` 为 `"1.3"`。

| Wire | Companion API | 核心能力与远程投影 |
|---|---|---|
| `1.3` | `new CompanionRelayBridgeV11({ ..., protocolVersion: "1.3" })` | 继承 `1.2`；Snapshot 新增可空 `contextRecovery`，事件流新增 `context.recovery.changed` |
| `1.2` | `new CompanionRelayBridgeV11({ ..., protocolVersion: "1.2" })`（官方 `roll companion` 当前默认值） | 继承 `1.1`；新增只读 `operation.result.get`，`OperationView` 与 `tool.completed` 携带轻量 `appOutput` 描述符 |
| `1.1` | `new CompanionRelayBridgeV11({ ... })`（底层构造默认 `"1.1"`） | 通用类型化交互 `interaction.request/resolved/cancelled` + `interaction.candidate` 与远程脱敏投影 |
| `1.0` | `CompanionRelayBridge.connect(transport)` | 冻结的旧版 Approval 专属路径（仅限同等本地信任边界） |

所有不带版本后缀的旧版通用导出（如 `RELAY_PROTOCOL_VERSION`、`RELAY_REQUEST_METHODS`、`relayMessageSchema`）均冻结在 `"1.0"`。新代码应使用 `RELAY_PROTOCOL_REGISTRY`、`parseRelayMessageForVersion()`、`parseRelayRequestParamsForVersion()` 与 `parseRelayRequestResultForVersion()` 按协商版本校验；`1.0` 的方法表、Schema 与测试夹具不再扩充。

冻结 Wire `1.0` 仅旨在维持旧版接口兼容，并不代表其载荷已满足远程威胁模型下的脱敏要求。它仅适用于同等受信任本地边界内的旧版对端，绝不能作为面向不可信云端或浏览器的安全降级路径。凡涉及远程暴露的生产宿主，必须协商 Wire `1.1` 及以上版本（官方 Companion 默认协商 `"1.2"`，在匹配的 Relay 部署下可开启 `"1.3"`），协商失败时必须直接拒绝连接。

Relay Wire 版本与 npm 包版本、本地 Runtime Protocol 版本（当前最新为 `"1.6"`）各自独立演进。本地 Runtime `1.2–1.6` 的新增字段绝不能绕过投影直接塞入低版本 Wire 帧，每一层都必须按自身版本的注册表校验并转换。

## Wire 1.1–1.3 消息与版本扩展

Wire `1.1`、`1.2` 与 `1.3` 共享相同的 10 种外层消息 `type`：

| 消息 `type` | 方向 | 用途 |
|---|---|---|
| `device.connect` | Companion → Relay | 携带 `protocolVersion`（`"1.1"` / `"1.2"` / `"1.3"`）、`deviceId` 与 `pairingToken` |
| `runtime.request` | Relay → Companion | 查询/写操作或 `interaction.candidate`（`1.2–1.3` 包含 `operation.result.get`） |
| `runtime.response` | Companion → Relay | 请求结果或统一脱敏后的稳定错误 |
| `runtime.event` | Companion → Relay | 脱敏后的 Runtime 事件投影（`1.2+` 含 `tool.completed.appOutput` 描述符，`1.3` 含 `context.recovery.changed`） |
| `interaction.request` | Companion → Relay | 安全的 Approval / User Input 请求投影 |
| `interaction.resolved` | Companion → Relay | 逻辑交互已结算；不携带完整提交结果 |
| `interaction.cancelled` | Companion → Relay | 逻辑交互已取消；不携带本机内部报错详情 |
| `runtime.ack` | Relay → Companion | 确认已连续处理的最高 `relaySequence` |
| `runtime.gap` | Companion → Relay | 通知帧缓冲缺口；引导前端回退读取 `thread.snapshot` |
| `runtime.encrypted` | 双向 | Workspace 载荷加密信封 |

`device.connect.pairingToken` 是沿用的历史字段名。在实际部署中，它承载设备注册（enrollment）签发并保存在系统钥匙串（Keychain / DPAPI）中的长期设备凭据，绝不是用户输入的一次性配对码。

`runtime.event` 与三类 Interaction 帧共用单个 Workspace 级别的递增 `relaySequence`。Relay ACK 仅确认该安全投影流的投递进度，不会确认本地 Runtime 的 `eventCursor`，协议也不设持久化的 Relay outbox。

### Wire 1.2 扩展：结构化应用输出（App output）

- **新增查询方法**：`RELAY_REQUEST_METHODS_V12` 在 `RELAY_REQUEST_METHODS_V11` 的基础上新增只读查询 `operation.result.get`，完整结构化输出仅通过该显式查询按需传输。
- **描述符投影**：`thread.open`、`thread.snapshot`、`operation.get` 中的 `OperationView` 以及 `tool.completed` 事件新增轻量的 `appOutput` 状态描述符（不含完整 JSON `data`）；`thread.capabilities` 保留经过远程门禁过滤后的 `appOutput` 工具能力声明。
- **本机授权门禁**：`CompanionWorkspace` 接收可选的 `remoteAppOutputPolicy(agentName, toolName)` 钩子。仅当工具契约声明 `remoteReadable: true` 且该策略对当前查询返回 `true` 时，才向远端暴露该工具的 `appOutput` 能力与完整结果；未获授权时 `operation.result.get` 安全返回 `output: { status: "denied" }`。
- **投影与向下兼容辅助函数**：`@roll-agent/relay-protocol` 导出 `projectRelayThreadSnapshotV12()`、`projectRelayOperationGetResultV12()`、`projectRuntimeEventEnvelopeForRelayV12()`；向仅支持 Wire `1.1` 的浏览器下发前，可通过 `projectRelayMessageV12ToV11()` 剥离 `tool.completed` 上的 `appOutput` 与 `operationId`，并通过 `projectRelayCapabilitiesV11()` 剥离能力清单中的 `appOutput` 声明。

### Wire 1.3 扩展：有界上下文恢复状态（Context recovery）

- **方法集合**：复用 `RELAY_REQUEST_METHODS_V12` 的全部远程方法。
- **状态与事件投影**：`thread.open` 与 `thread.snapshot` 结果新增可空的 `contextRecovery` 字段（仅暴露 `{ checkpointId, required, unextracted, requiredItemCount }` 有界门禁计数，不含模型笔记或归档原文）；`runtime.event` 允许转发 `context.recovery.changed` 事件。
- **投影与向下兼容辅助函数**：导出 `projectRelayThreadSnapshotV13()`、`projectRuntimeEventEnvelopeForRelayV13()`，以及向 Wire `1.2` 对端降级（将 `context.recovery.changed` 兼容映射为 `capabilities.changed`）的 `projectRelayMessageV13ToV12()`。

### Typed Interaction

Wire `1.1–1.3` 支持两类远程交互：

| `method` | request projection | candidate |
|---|---|---|
| `approval.request` | `approvalId` / `agentName` / `toolName` / `explanation?` | `{ decision: "approve" \| "reject", reason? }` |
| `userInput.request` | `title` / `description` 与五类安全表单控件 | `submitted` / `cancelled` User Input Result |

请求帧公共字段为 `interactionId`、`threadId`、`turnId`、`expiresAt` 与 `sensitivity`（当前固定为 `"normal"`）。远端统一通过写操作 `interaction.candidate` 提交响应候选：

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

返回 `{ "accepted": true }` 仅代表候选已被本机 Broker 接收并进入结算，并不代表目标工具已经执行完成；浏览器仍须等待有序到达的 `interaction.resolved` 或 `interaction.cancelled` 收敛界面状态。

候选请求按以下五步依次校验：

1. Wire Schema 先行拦截非法信封、未知 `method` 与畸形的 `candidate` 结构。
2. 宿主注入的 `requestPolicy` 在查询请求缓存与转发 Runtime 之前校验目标 `workspaceId` 与 `method`；被拒绝时统一返回 `REMOTE_REQUEST_DENIED`，不暴露本机内部原因。
3. 宿主注入的 `responderPolicy` 校验当前认证会话/连接周期（generation）是否具备响应资格。
4. Broker 对照当前挂起的 Interaction 与 Runtime 原始请求参数执行二次业务校验；对于 User Input，还会按原始控件定义顺序规范化提交值。
5. 若为审批 `approve`，还会经过本地 `localApprovalPolicy` 复核（`reject` 仅收窄权限，直接放行）。官方 P0 宿主的本地审批策略固定放行 Runtime 已生成的 `confirm` 交互，不额外弹出电脑端确认框。

完全相同的 `workspaceId + requestId` 重投直接返回缓存响应；若复用同一 `requestId` 却传入不同的 `method` 或 `params`，则返回 `RELAY_REQUEST_ID_CONFLICT`。当触发 Runtime 取消、Turn 进入终态、到达截止时间、解绑 Workspace、关闭桥接器或重连导致旧连接周期失效时，交互均走单次原子终止路径，旧连接周期上迟到的异步候选无法完成结算。

### 安全边界

以下敏感数据严禁进入 Relay Wire：

- 本地 Runtime JSON-RPC `id`；
- 原始 Tool 输入/输出、执行证据（evidence）与凭据密钥；
- 用户提交的完整 User Input Result 明文；
- 本机内部授权状态、策略抛错原文与本地确认凭据。

`interaction.resolved` 与 `interaction.cancelled` 仅携带关联标识和 `method`，不含完整提交值或内部报错正文。即便 `approval.required` 等 Runtime 时间线事件经过脱敏转发到了远端，它们也仅作为只读历史记录展示；任何远程交互提交都必须命中本机 Broker 当前挂起的 `interactionId`，绝不能凭时间线事件直接触发控制动作。

主动拉取查询遵循同等的脱敏标准：`thread.open` 与 `thread.snapshot` 会将审批 `preview` 裁剪为可选的简短 `explanation`、移除本地 `reason`，并清空 `OperationView` 的 `display` 与失败详情；`operation.get` 复用相同的 Operation 脱敏规则。`CompanionRelayBridgeV11` 会根据桥接器配置的 Wire 版本自动调用 `projectRelayThreadSnapshotV11()` / `V12()` / `V13()`、`projectRelayOperationGetResultV11()` / `V12()` 及 `projectRelayCapabilitiesV11()`，遇到畸形的 Runtime 结果时立即抛错并按 fail-closed 拒绝；自定义宿主在拼装 `runtime.response` 前也必须显式执行对应的投影函数，不得直接透传 Runtime 原始返回值。

`CompanionRelayBridgeV11` 对外发出的 `runtime.response.error` 严格收敛为以下固定映射：

| 来源 | Wire `code` | 固定公开 `message` | `retryable` |
|---|---|---|---:|
| 加密载荷认证或解析失败 | `ENCRYPTED_PAYLOAD_INVALID` | `Encrypted Relay payload could not be authenticated or parsed` | `false` |
| 绑定 cipher 的 Workspace 收到明文请求 | `RELAY_ENCRYPTION_REQUIRED` | `Encrypted Relay request required for this workspace` | `false` |
| Host `requestPolicy` 拒绝该请求 | `REMOTE_REQUEST_DENIED` | `Remote request denied` | `false` |
| Workspace 未与当前 Companion 绑定 | `WORKSPACE_NOT_FOUND` | `The requested workspace is not paired with this Companion` | `false` |
| 同一 `requestId` 携带冲突的方法或参数重投 | `RELAY_REQUEST_ID_CONFLICT` | `Relay requestId was reused with different method or params` | `false` |
| 请求参数校验失败 | `INVALID_PARAMS` | `Invalid Relay request params` | `false` |
| Runtime `RollRpcError` | `rollCode`（缺失时为 `JSON_RPC_<code>`） | `Runtime request failed` | 取 Runtime 显式值，缺失时为 `false` |
| `LocalApprovalDeniedError`（本地策略拒绝或校验异常） | `LocalApprovalDeniedError` | `Local approval denied` | `false` |
| 需要本机二次确认 | `LocalConfirmationRequiredError` | `Local confirmation required` | `false` |
| 其他未分类 Companion 异常 | `COMPANION_ERROR` | `Companion request failed` | `false` |

上述映射绝不回传 Runtime、本地策略或异常对象的原始错误文本。自定义宿主必须保持相同的固定公开文案与 fail-closed 行为。旧版 Wire `1.0` 桥接器虽然也会将异常收敛为固定文案，但并不具备 Wire `1.1–1.3` 的查询与交互脱敏投影能力，仍仅限同等本地信任边界使用。

以下信息属于设计上保留的远端可见范围：完整对话消息文本、会话标题/模型/时间戳元数据、安全时间线中的流式消息与推理摘要、Turn 状态、工具名称与完成状态摘要、已获授权的 `appOutput` 结果，以及 `thread.capabilities.manifest` 中可能包含的工作目录、操作系统平台、模型、Agent、Skill、工具参数 Schema、规则标识与版本控制元数据。Cloud Relay 与前端应用仍须将它们作为用户私有敏感数据妥善保护。

`authentication.request` 与文件选择器（File Picker）没有远程投影器，也不会在 Companion 中注册对应 handler，始终保持仅限本地使用；Runtime `1.3–1.6` 的持久事件重放不会扩大这一边界，未来若需支持远程调用，必须先通过专项安全设计评审。

## ID 与 cursor

| 标识或游标 | 生命周期 | 用途 |
|---|---|---|
| Runtime JSON-RPC `id` | 当前本地 Runtime 连接的单次投递 | 本地请求/响应关联 |
| `interactionId` | 一次逻辑 Interaction 的完整生命周期 | `interaction.request/resolved/cancelled` 与候选提交关联 |
| Relay `requestId` | 一次 Relay 请求及其断线重投 | Relay 响应关联、参数冲突检测与结果缓存 |
| Runtime mutation `params.requestId` | 一次 Runtime 写操作 | 本地 Runtime 幂等去重键 |
| Relay `relaySequence` / ACK | 单 Workspace 的 Relay 投递流 | 安全投影帧排序、重投、ACK 与缺口检测 |
| Runtime process `sequence` | 当前 `runtimeInstanceId` 进程内 | 实时事件进程内排序，不持久化 |
| Runtime `eventId` / `eventCursor` | 单 Thread 的 durable event 日志 | `1.3–1.6` 持久事件重放、去重与 Snapshot 检查点 |

上述标识与游标严禁混用：Relay `requestId` 不能充当 `interactionId` 或 Runtime 写操作 `requestId`；Relay `relaySequence` 按 Workspace 安全投影流排序，而 Runtime `eventCursor` 按 Thread 持久日志排序，Relay ACK 绝不能用来确认 Runtime `eventCursor`。

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
  remoteAppOutputPolicy,
  localApprovalPolicy,
});
const bridge = new CompanionRelayBridgeV11({
  deviceId,
  pairingToken,
  // 底层默认 "1.1"；官方 roll companion 默认传入 "1.2"，匹配 Relay 部署后可传入 "1.3"。
  protocolVersion: "1.2",
  workspaces: new Map([[workspaceId, workspace]]),
});

bridge.connect(authenticatedTransport, {
  requestPolicy,
  responderContext: authenticatedSession,
  responderPolicy: ({ responderContext, signal }) =>
    authorizeResponder(responderContext, { signal }),
});
```

其中 `responderContext` 是由宿主自行维护的不透明会话上下文，Companion 不会解析其内部字段，也不会仅凭该值完成生产级身份认证或控制权选举。`CompanionInteractionBroker` 同时支持 Runtime `1.2–1.6` 的类型化交互与 Runtime `"1.1"` 的 Approval 兼容门面；若本地 Runtime 未成功注册并确认对应 handler，Broker 会直接按 fail-closed 拒绝，绝不从时间线事件拼凑或回退产生未授权响应。

`CompanionInteractionBroker` 统一管理未决交互与租约：Approval 持有独立的 `approval` 租约，User Input 则复用所属 Turn 的租约。它在 Runtime handler 触发时发布远程请求帧，并在返回结果、收到取消、超时、Turn 进入终态、释放绑定或关闭桥接器时保证只结算并释放一次。

旧版 `CompanionApprovalRequestBroker` 已弃用，新代码应统一使用 `CompanionInteractionBroker`。旧版单参数 `CompanionRelayBridge.connect(transport)` 不接受 `1.1+` 策略选项，固定发送 `protocolVersion: "1.0"`。

## ACK、buffer 与重连

在 Wire `1.1–1.3` 下，`CompanionRelayFrameBuffer` 将脱敏后的 Runtime 事件与 Interaction 帧编入同一条有序流，默认上限为 `10,000` 条或 `32 MiB`，仅保存在进程内存中：

- ACK 序号不能超过当前传输连接周期（generation）已成功发出的最高连续序号；
- 断线重连会启用新的连接周期与独立发送队列，按序重投尚未收到 ACK 的帧；
- 若请求续传的缓冲前缀已被裁剪，则下发 `runtime.gap` 引导浏览器回退读取 `thread.snapshot`；
- 旧连接周期关闭时会立即中止其正在提交的候选请求，迟到的异步结果不会写入新连接；
- 调用桥接器的 `close()` 会进入不可逆终态，并立即终止所有仍处于 pending 状态的远程交互。

该内存缓冲区并非持久化 outbox、Interaction WAL 或 Runtime 持久事件日志。Companion 进程重启后必须重新建立 Workspace 状态；若本地 Runtime 协商到了 `1.3–1.6`，本机侧可通过 `runtime.events.resume` 恢复持久事件，否则通过 Snapshot 收敛。Runtime 事件恢复的响应屏障与 Relay ACK 分属两条完全独立的生命周期。

## Workspace payload cipher

Wire `1.1–1.3` 共用 `RelayPayloadCipherV11` 接口。配置了 cipher 的 Workspace 仅接受 `runtime.encrypted` 请求，所有响应、事件与交互帧也一律封装为加密信封下发；Cloud Relay 仍可读取外层的 `workspaceId`、`payloadKind`、`requestId` 或 `relaySequence` 等路由元数据。

加密算法选型、AEAD、nonce 管理、密钥协商/轮换、浏览器端加解密实现与密钥存储均由宿主负责；`decrypt()` 实现必须同时校验 `algorithm` 与外层信封元数据，而不能只做密文解码。

## 出站连接与测试 fake

`OutboundCompanionRelayV11.connectTransport()` 在每次建立或重建连接时返回：

```ts
{
  transport: RelayTransportV11;
  requestPolicy: RemoteRequestPolicy;
  responderPolicy: RemoteInteractionResponderPolicy;
  responderContext: unknown;
}
```

该结构将请求白名单与交互响应授权严格绑定到具体的已认证连接周期。`start()` 启动带指数退避的自动重连循环；`stop()` 同步关闭当前 Transport 与桥接器，而本地 Runtime 的关闭仍由 `CompanionWorkspace` 宿主按租约空闲状态管理。

`createWebSocketRelayTransportV11()` 仅提供基础的 WebSocket 文本 JSON 帧适配，生产级宿主仍须自行实现连接鉴权、单帧字节上限、心跳检测、结构化日志与协议诊断。

`@roll-agent/companion/testing` 导出的 `InMemoryRelayTransportV11` 仅供单测确定性地验证候选提交、重复请求、ACK 推进、断线重连与旧连接周期隔离，不包含身份鉴权、控制权选举或可靠持久化，严禁用于生产环境。

## 相关文档

- [Runtime Protocol 架构与安全边界](./runtime-protocol-architecture.md)
- [使用自己的技术栈接入 Roll](./how-to-build-roll-runtime-ui.md)
- [`@roll-agent/client-node` API 参考](./client-node-reference.md)
