# `@roll-agent/companion`

连接远程 Web UI 与用户本机 Roll Runtime 的 Local Companion 基础库。

本包只运行在用户本机的 Node.js Host（例如 Electron Main 或独立 Companion daemon），消费
`@roll-agent/relay-protocol` 的 Relay Wire 契约，并提供 Workspace 生命周期、Interaction
Broker、Relay ACK/gap 缓冲、mutation 去重、出站重连和可插拔 payload cipher。

它不包含生产 Cloud Relay、Browser SDK、账号/设备身份、controller 选举、TLS、可靠投递、
持久 outbox、Interaction WAL、本地确认 UI 或自动启动机制。安装本包或
`@roll-agent/core` 不会建立远程连接；宿主必须显式完成认证并启动 bridge。

## 安装

```bash
pnpm add @roll-agent/companion @roll-agent/client-node @roll-agent/relay-protocol
```

## Relay Wire 1.1

Wire 1.1 使用显式的 `CompanionRelayBridgeV11` API。Runtime 的
`approval.request` / `userInput.request` 由 `CompanionInteractionBroker` 注册为 named
handlers，再投影成安全的 `interaction.request/resolved/cancelled` 帧。远端只能通过
`interaction.candidate` 提交候选结果。

```ts
import { RollNodeClient } from "@roll-agent/client-node";
import {
  CompanionInteractionBroker,
  CompanionRelayBridgeV11,
  CompanionWorkspace,
  OutboundCompanionRelayV11,
  createRuntimeServerRequestHandlers,
} from "@roll-agent/companion";
import { deviceIdSchema, workspaceIdSchema } from "@roll-agent/relay-protocol";

const interactionBroker = new CompanionInteractionBroker();
const runtime = await RollNodeClient.start({
  cwd: workspacePath,
  serverRequestHandlers: createRuntimeServerRequestHandlers(interactionBroker),
});

const workspaceId = workspaceIdSchema.parse(savedWorkspaceId);
const workspace = new CompanionWorkspace({
  client: runtime,
  workspaceId,
  interactionBroker,
  localApprovalPolicy: async () => "require-local-confirmation",
});
const bridge = new CompanionRelayBridgeV11({
  deviceId: deviceIdSchema.parse(savedDeviceId),
  pairingToken,
  workspaces: new Map([[workspaceId, workspace]]),
});
const outbound = new OutboundCompanionRelayV11({
  bridge,
  connectTransport: async () => ({
    transport: await openAuthenticatedRelayTransport(),
    responderContext: authenticatedRelaySession,
    responderPolicy: async ({ responderContext, signal }) =>
      authorizeInteractionResponder(responderContext, { signal }),
  }),
});

outbound.start();
```

`responderContext` 是宿主注入的不透明认证/会话状态；Companion 不解释它，也不因其存在就声称
Browser 已认证或 controller 已选出。Wire Schema 先拒绝畸形帧；合法 candidate 再经过宿主的
responder policy，然后按 Runtime 原始请求做 method-specific 校验。Approval 的 approve 候选
还必须通过本地 Approval Policy；reject 不扩大权限。User Input 候选按原始表单规范化，完整
结果只回给 Runtime。

Wire 投影有意最小化：

- Approval 只包含 `approvalId/agentName/toolName/explanation?`。
- User Input 只包含安全表单字段。
- Runtime JSON-RPC `id`、原始 Tool input/output、secret、完整 User Input Result 和本地授权
  状态都不会进入 Wire。
- `authentication.request` 与 File Picker 不注册远程 projector，保持 local-only。

Runtime cancel、Turn 终态、deadline、Workspace 解绑、bridge 关闭和重连 generation 失效共用
单次终止语义；旧 generation 的迟到候选不会结算新的连接。`interaction.resolved` 也不携带完整
结果，Browser 只用终态帧收敛视图。

## Wire 1.0 兼容

旧的 `CompanionRelayBridge.connect(transport)`、`OutboundCompanionRelay`、通用未带版本后缀的
Relay exports，以及 `CompanionApprovalRequestBroker` 均固定为 Wire 1.0。后者已 deprecated，
保留一个 minor 周期用于 `approval.required` / `approval.candidate` 兼容路径。

新 Host 必须显式选择 `CompanionRelayBridgeV11` 才能发送 typed Interaction；协商到 1.0 的
peer 只使用既有 Approval 路径，不会收到 1.1 Interaction 帧。

## ACK、重连与加密

Wire 1.1 的安全 Runtime event 与 Interaction 帧共享单个 Workspace `relaySequence`。ACK 只能
推进当前 generation 已成功发送的连续前缀；重连会重投未 ACK 帧，缓冲缺口要求
`thread.snapshot` 收敛。所有 buffer、ACK、dedupe 和 lease 都只在 Companion 进程内，不能当作
持久事件日志或可靠 outbox。

配置 `RelayPayloadCipherV11` 后，request/response/event/interaction 必须走
`runtime.encrypted`。算法、AEAD、nonce、密钥协商/轮换和 Browser 实现仍由宿主负责。

## 测试 fake

`@roll-agent/companion/testing` 导出 `InMemoryRelayTransportV11`，用于协议测试中的候选注入、
重复、ACK、断线和旧 generation 迟到消息。它不提供生产身份、鉴权、controller 选举、可靠
投递、持久 outbox 或 WAL，不能作为生产 Transport。

## 文档

- [`@roll-agent/relay-protocol` Relay 1.1/1.0 参考](https://github.com/steveoon/roll-agent/blob/main/docs/companion-relay-v1-reference.md)
- [使用自己的技术栈接入 Roll](https://github.com/steveoon/roll-agent/blob/main/docs/how-to-build-roll-runtime-ui.md)
- [Runtime Protocol 架构与安全边界](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-architecture.md)
