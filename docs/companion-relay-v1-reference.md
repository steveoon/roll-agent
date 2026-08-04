# `@roll-agent/relay-protocol` Relay v1 参考

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

`@roll-agent/relay-protocol` 是 Browser、Cloud Relay 和 Local Companion 共享的唯一 Wire
契约来源，提供 Relay version、显式冻结的消息/方法注册表、ID Schema、JSON Schema、
fixtures 与 TypeScript types。它是 Browser-safe 的纯协议包，不包含 Transport、账号、
数据库、Policy 或部署代码。

`@roll-agent/companion` 消费上述契约并提供用户本机 Host 侧 bridge、Workspace lease、本地
Approval Policy、ACK/gap 缓冲、去重与出站重连。它不定义第二套 Wire Schema，也不包含
生产 Cloud Relay Server、Browser SDK、账号/设备存储、鉴权授权、TLS、心跳、帧大小限制、
HA、监控或本地确认 UI。

### 安装与运行位置

| 组件 | 直接依赖 | 运行位置 |
|---|---|---|
| Browser Web App | `@roll-agent/relay-protocol` | 用户浏览器 |
| Cloud Relay Server | `@roll-agent/relay-protocol` | 云端 |
| Local Companion Host | `@roll-agent/companion`、`@roll-agent/client-node`、`@roll-agent/relay-protocol` | 用户本机 Node/Electron Main/daemon |
| Local-only Desktop GUI | `@roll-agent/client-node`，按需加 `@roll-agent/protocol` | 用户本机；不需要 Companion |

`@roll-agent/companion` 当前是可嵌入的库，不是已安装即运行的应用：它没有 CLI、daemon、
登录/配对 UI 或自动启动机制。全局安装 `@roll-agent/core` 只提供 `roll` CLI 和 Runtime，
不会安装或启动 Companion。只有宿主显式启动 `OutboundCompanionRelay`，或向
`CompanionRelayBridge` 绑定已经建立的 Transport 后，才会产生 Relay 连接。

## 版本与消息

| 项目 | 值 |
|---|---|
| Relay protocol | `"1.0"` |
| 默认事件缓冲 | `10,000` 条 / `16 MiB` |
| 默认 mutation 结果缓存 | `10,000` 个已完成结果 |
| 默认重连退避 | `500 ms` 起，最高 `30,000 ms` |
| 状态持久性 | 仅 Companion 进程内 |

当前包只冻结已经存在的 Relay Wire `"1.0"`，其 message/method 集合不会再随最新
`RUNTIME_METHODS` 自动扩张。新增 Wire message、method 或必需 handler 必须进入显式的新
Relay version，并提供兼容矩阵；不能静默修改 `"1.0"`。

这里冻结的是 Relay envelope、recognized method registry，以及这些 method 在旧 Wire 上
使用的 Runtime Protocol `"1.1"` 兼容 Params/Result 视图；registry 会明确区分 `query`、
`mutation` 和不得转发的 `local-only`。`relayRequestMethodSchemas` 明确绑定该冻结视图，
不会随最新 `@roll-agent/protocol` registry 自动扩张。

Relay `"1.0"` 只描述外层信封与传输；嵌套事件携带 Runtime 兼容版本。本地 Runtime
`"1.2"` 事件会投影成 `protocolVersion: "1.1"`，Browser 必须逐 Workspace 记录该版本：
收到 `"1.0"` 的 `approval.required` 时发送 `approval.respond`，收到 `"1.1"` 时发送
`approval.candidate`。因此新 Runtime 与旧 Browser/Companion 滚动共存时不会把 1.2 字段
偷渡进旧 Wire，也不能从外层 Relay 版本猜测审批能力。

| 消息 `type` | 方向 | 用途 |
|---|---|---|
| `device.connect` | Companion → Relay | 协议版本、设备 ID、pairing token |
| `runtime.request` | Relay → Companion | Runtime 方法或 Relay 专属 `approval.candidate` 请求 |
| `runtime.response` | Companion → Relay | 未绑定 cipher 的 Workspace 明文结果或稳定错误 |
| `runtime.event` | Companion → Relay | 未绑定 cipher 的 Workspace 事件与 Relay sequence |
| `runtime.ack` | Relay → Companion | 确认已接收的最高 Relay sequence |
| `runtime.gap` | Companion → Relay | 缓冲缺口；恢复方式为 `thread.snapshot` |
| `runtime.encrypted` | 双向 | Workspace payload cipher 信封 |

### ID 与 cursor

跨 Runtime 与 Relay 的 correlation、逻辑交互、幂等和投递进度分为五类；它们不能互相
代替：

| 标识或游标 | 生命周期 | 用途 |
|---|---|---|
| Runtime JSON-RPC `id` | 当前 Runtime 连接上的一次投递 | Runtime Request/Response correlation；断线重投可生成新值 |
| `interactionId` | 未来 typed interaction 的完整逻辑生命周期 | 关联 request/result/cancelled、重投与恢复；Relay `"1.0"` 尚未定义 |
| Relay `requestId` | 一次逻辑 Relay request 及其重投 | Browser/Relay 与 Companion response correlation、冲突检测和响应缓存 |
| Runtime mutation `params.requestId` | 一次 Runtime 写操作 | `turn.start` 等 mutation 的 Runtime 幂等键 |
| `sequence` / cursor | 各自所属的有序流 | Runtime event 恢复或 Relay delivery ACK |

其中第五类包含两个不能互换的序列空间：

| cursor | 权威范围 | 恢复/确认方式 |
|---|---|---|
| `RuntimeEventEnvelope.sequence` | 单个 `runtimeInstanceId` 内的 Runtime event 顺序 | Runtime 重启后使用 `thread.snapshot` 收敛，不能跨实例续接 |
| Relay `relaySequence` / ACK cursor | 单个 Workspace 的 Companion→Relay 投递进度 | `runtime.ack`、gap 与重投；不能 ACK Runtime event cursor |

因此每个新 mutation 必须分别生成 Relay `requestId` 与 Runtime
`params.requestId`；不能把 Runtime JSON-RPC `id`、任一 sequence 或未来
`interactionId` 当成另一个层的幂等键。`threadId`、`turnId`、`approvalId` 等业务对象 ID
不属于上述五类。

`"1.1"` Approval 是例外：Browser 不直接转发 Runtime 的 `approval.respond`，而是提交
Relay 专属候选决定：

```json
{
  "type": "runtime.request",
  "requestId": "00000000-0000-4000-8000-000000000701",
  "workspaceId": "00000000-0000-4000-8000-000000000702",
  "method": "approval.candidate",
  "params": {
    "threadId": "00000000-0000-4000-8000-000000000703",
    "turnId": "00000000-0000-4000-8000-000000000704",
    "approvalId": "00000000-0000-4000-8000-000000000705",
    "decision": "approve",
    "reason": "用户已确认"
  }
}
```

成功响应沿用 `runtime.response` 信封，`result` 为 `{ "accepted": true }`。这里的
`accepted` 只表示本机 Broker 已接受并处理该候选，不代表 Tool 已执行；Browser 必须等待
权威 `approval.resolved` Event 收敛 View。`approval.candidate.params` 不包含 Runtime
mutation `requestId`，幂等键只有 Relay 外层 `workspaceId + requestId`。`"1.0"` fallback
才允许 `approval.respond -> { resolved: true }`。可选 `reason` 一旦提供就必须是非空
字符串；参数不合法时返回
`{ code: "INVALID_PARAMS", message: "Invalid Relay request params", retryable: false }`。

`initialize` 由本地 Companion 与 Runtime 完成，不能通过 Relay 转发。

`approval.candidate` 是 Relay `"1.0"` 中已冻结的 Approval 专属候选方法，不代表通用
Server→Browser interaction 已经落地。通用 typed interaction
request/result/cancelled、逻辑 `interactionId` 和跨连接恢复属于
[#184](https://github.com/steveoon/roll-agent/issues/184)、
[#187](https://github.com/steveoon/roll-agent/issues/187) 以及后续 Relay Wire version；
不能通过向 `"1.0"` 注册表追加字段或 method 来实现。

## `CompanionWorkspace`

```ts
const approvalRequestBroker = new CompanionApprovalRequestBroker();
const runtimeClient = await RollNodeClient.start({
  cwd: workspacePath,
  serverRequestHandlers: {
    "approval.request": approvalRequestBroker.handle,
  },
});
const workspace = new CompanionWorkspace({
  client: runtimeClient,
  approvalRequestBroker,
  localApprovalPolicy,
  maxEvents: 10_000,
  maxBytes: 16 * 1024 * 1024,
});
```

| API | lease | 说明 |
|---|---|---|
| `attachBrowser(clientId)` | `client`，手动 | 返回 release 函数 |
| `detachBrowser(clientId)` | `client`，手动 | 由认证连接控制面调用 |
| `acquireBackgroundShellLease(sessionId)` | `shell-session`，手动 | 返回 release 函数 |
| `startTurn()` | `turn`，自动 | 终态事件自动释放 |
| `submitApprovalCandidate()` | 已有 Broker approval lease | `"1.1"` 提交 Relay 候选，返回 `{ accepted: true }` |
| `respondApproval()` | `approval`，自动 | 仅 `"1.0"` Event fallback；`"1.1"` 会拒绝 |
| `replay(afterSequence)` | 无 | 返回未 ACK 事件及可选 gap |
| `acknowledge(throughSequence)` | 无 | 释放已确认缓冲 |
| `closeIfIdle()` | 无 | 无任何 lease 时才关闭 Runtime，返回是否已关闭 |

Browser/Shell 的身份与连接生命周期不在 Relay 消息 Schema 中，必须由经过认证的 Relay/
Companion 宿主显式接线。

### 本地批准策略

`localApprovalPolicy(approval, { signal })` 返回：

| 值 | 行为 |
|---|---|
| `"allow"` | Broker 向 Runtime 返回 approve Result |
| `"deny"` | Broker 向 Runtime 返回 reject，并向远端抛出 `LocalApprovalDeniedError` |
| `"require-local-confirmation"` | 抛出 `LocalConfirmationRequiredError` |

`"require-local-confirmation"` 不会自动弹窗。宿主必须实现本地 UI 和一次性确认状态，再允许
后续批准继续。Runtime 取消请求时会同步 abort `signal`；非法返回值或 Policy 异常会
fail-closed、终止 Runtime Handler 并释放 lease。未知本地异常对 Relay 统一返回
`COMPANION_ERROR / Companion request failed`，不会把内部错误消息发送到远端。

Broker 必须在 Runtime Client 初始化前作为 `approval.request` handler 注册。`"1.1"` 不再从
`approval.required` 复制 Approval 业务状态；Handler 开始时获取 lease，Result、Runtime
Cancel、连接退出或 Handler 失败时释放。远端 reject 不会扩大权限，因此不调用授权 Policy。
Relay bridge 会把 `approval.candidate` 视为 mutation，使用与其他 mutation 相同的有界
响应缓存和 `workspaceId + requestId` 冲突检测。

## `CompanionRelayBridge`

```ts
const bridge = new CompanionRelayBridge({
  deviceId,
  pairingToken,
  workspaces,
  ciphers,
  maxRequestCacheEntries: 10_000,
});
```

- mutation 按 `workspaceId + Relay requestId` 去重；
- 指纹包含 Workspace、method 与 params，并递归规范化 JSON object key 顺序；同 ID 配
  不同语义请求会被拒绝；
- 执行中的 mutation 不受 LRU 容量淘汰；
- 已完成成功/失败结果进入有界 LRU；
- 读取请求不缓存大型 Snapshot；
- ACK 不能超过当前 Transport 已成功发送的最高 sequence；
- 每次重连使用独立发送队列，旧连接阻塞不会卡住新连接。

所有缓存、ACK、sequence 和 lease 都是进程内状态。Companion 重启后必须重新建立设备/
Workspace 状态，并通过 `thread.snapshot` 收敛 UI；不能把 Relay buffer 当作持久事件日志。

这里的 ACK 只推进 Relay `relaySequence`，不确认
`RuntimeEventEnvelope.sequence`。Runtime event cursor 与 Relay delivery cursor 即使数值
偶然相同，也没有可替换关系。

## Workspace payload cipher

`ciphers` 按 Workspace 注入：

```ts
interface RelayPayloadCipher {
  algorithm: string;
  encrypt(value: JsonValue): Promise<{ nonce: string; ciphertext: string }>;
  decrypt(message: RelayEncryptedMessage): Promise<JsonValue>;
}
```

配置 cipher 的 Workspace 只接受 `runtime.encrypted` request，response/event 也只以
`runtime.encrypted` 发送。明文 request 不会进入 Runtime，而会收到同样经过加密的
`RELAY_ENCRYPTION_REQUIRED`（`retryable: false`）响应。Relay 仍可看到 Workspace ID、
payload kind、request ID 或 sequence 等路由元数据。

本包只定义 cipher hook 与 encrypted-only enforcement。算法选择、AEAD、nonce 管理、
密钥协商/轮换、Browser 实现和密钥存储均由宿主负责；`decrypt()` 也必须验证算法与信封
元数据，而不能只解码 `ciphertext`。

## `OutboundCompanionRelay`

```ts
const outbound = new OutboundCompanionRelay({
  bridge,
  connectTransport,
  minReconnectMs: 500,
  maxReconnectMs: 30_000,
});
```

`start()` 启动主动出站连接和指数退避重连。`stop()` 关闭 Transport、Bridge 及 Workspace
事件订阅，应视为终态操作；它不会关闭 Runtime。Runtime 生命周期应单独通过
`workspace.closeIfIdle()` 管理。

这两个方法只会被 Companion Host 的显式生命周期代码调用；安装 npm 包、启动普通
`roll chat`、运行 Local-only Electron GUI 或执行 `roll runtime serve --stdio` 都不会隐式
创建 Relay 连接。

`createWebSocketRelayTransport()` 只提供文本 JSON adapter。它会忽略非法 JSON 与非文本
帧；生产 Transport 必须自行实现鉴权、帧上限、心跳、日志和协议诊断。

## 相关文档

- [Runtime Protocol 架构与安全边界](./runtime-protocol-architecture.md)
- [使用自己的技术栈接入 Roll](./how-to-build-roll-runtime-ui.md)
- [`@roll-agent/client-node` API 参考](./client-node-reference.md)
