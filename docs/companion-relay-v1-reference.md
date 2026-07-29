# `@roll-agent/companion` Relay v1 参考

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

`@roll-agent/companion` 提供客户端侧基础能力，不包含生产 Cloud Relay Server、Browser
SDK、账号/设备存储、鉴权授权、TLS、心跳、帧大小限制、HA、监控或本地确认 UI。

## 版本与消息

| 项目 | 值 |
|---|---|
| Relay protocol | `"1.0"` |
| 默认事件缓冲 | `10,000` 条 / `16 MiB` |
| 默认 mutation 结果缓存 | `10,000` 个已完成结果 |
| 默认重连退避 | `500 ms` 起，最高 `30,000 ms` |
| 状态持久性 | 仅 Companion 进程内 |

| 消息 `type` | 方向 | 用途 |
|---|---|---|
| `device.connect` | Companion → Relay | 协议版本、设备 ID、pairing token |
| `runtime.request` | Relay → Companion | 未绑定 cipher 的 Workspace 明文请求 |
| `runtime.response` | Companion → Relay | 未绑定 cipher 的 Workspace 明文结果或稳定错误 |
| `runtime.event` | Companion → Relay | 未绑定 cipher 的 Workspace 事件与 Relay sequence |
| `runtime.ack` | Relay → Companion | 确认已接收的最高 Relay sequence |
| `runtime.gap` | Companion → Relay | 缓冲缺口；恢复方式为 `thread.snapshot` |
| `runtime.encrypted` | 双向 | Workspace payload cipher 信封 |

Relay 外层 `requestId` 用于跨 Relay 重投与响应关联；Runtime mutation 自己的
`params.requestId` 用于 Runtime 幂等。每个新 mutation 两层都必须生成新的 UUID，不能把
二者混为一个长期重用的 ID。

`initialize` 由本地 Companion 与 Runtime 完成，不能通过 Relay 转发。

## `CompanionWorkspace`

```ts
const workspace = new CompanionWorkspace({
  client: runtimeClient,
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
| `respondApproval()` | `approval`，自动 | `approval.required` 获取，完成/终态释放 |
| `replay(afterSequence)` | 无 | 返回未 ACK 事件及可选 gap |
| `acknowledge(throughSequence)` | 无 | 释放已确认缓冲 |
| `closeIfIdle()` | 无 | 无任何 lease 时才关闭 Runtime，返回是否已关闭 |

Browser/Shell 的身份与连接生命周期不在 Relay 消息 Schema 中，必须由经过认证的 Relay/
Companion 宿主显式接线。

### 本地批准策略

`localApprovalPolicy` 返回：

| 值 | 行为 |
|---|---|
| `"allow"` | 允许向 Runtime 提交远程批准 |
| `"deny"` | 抛出 `LocalApprovalDeniedError` |
| `"require-local-confirmation"` | 抛出 `LocalConfirmationRequiredError` |

`"require-local-confirmation"` 不会自动弹窗。宿主必须实现本地 UI 和一次性确认状态，再允许
后续批准继续。

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
- 指纹包含 Workspace、method 与 params；同 ID 配不同请求会被拒绝；
- 执行中的 mutation 不受 LRU 容量淘汰；
- 已完成成功/失败结果进入有界 LRU；
- 读取请求不缓存大型 Snapshot；
- ACK 不能超过当前 Transport 已成功发送的最高 sequence；
- 每次重连使用独立发送队列，旧连接阻塞不会卡住新连接。

所有缓存、ACK、sequence 和 lease 都是进程内状态。Companion 重启后必须重新建立设备/
Workspace 状态，并通过 `thread.snapshot` 收敛 UI；不能把 Relay buffer 当作持久事件日志。

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

`createWebSocketRelayTransport()` 只提供文本 JSON adapter。它会忽略非法 JSON 与非文本
帧；生产 Transport 必须自行实现鉴权、帧上限、心跳、日志和协议诊断。

## 相关文档

- [Runtime Protocol 架构与安全边界](./runtime-protocol-architecture.md)
- [使用自己的技术栈接入 Roll](./how-to-build-roll-runtime-ui.md)
- [`@roll-agent/client-node` API 参考](./client-node-reference.md)
