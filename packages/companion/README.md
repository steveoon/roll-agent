# `@roll-agent/companion`

连接云端 Web UI 与用户本机 Roll 的 Local Companion / Relay bridge 基础库。

本包只安装在用户本机的 Node.js Host 中，例如 Remote-enabled Electron Main 或独立
Companion Daemon。Browser Web App、Cloud Relay Server、普通 `roll chat` 和只做本地 GUI
的 Desktop App 都不安装它。

本包消费 `@roll-agent/relay-protocol` 的 Relay Wire 契约，提供 Workspace 生命周期
lease、本地 Approval Policy、事件 ACK/gap 缓冲、mutation 去重、出站重连和可插拔的
Workspace payload cipher。Wire Schema、ID、JSON Schema、fixtures 与版本注册表由
`@roll-agent/relay-protocol` 唯一维护；本包不再定义另一套协议。

本包不包含生产 Cloud Relay Server、Browser SDK、账号/设备存储、TLS、鉴权授权、本地确认
UI、HA 或监控，也不提供 CLI、daemon 或自动启动机制。`npm install` 与
`npm install -g @roll-agent/core` 都不会启动 Companion；宿主必须在用户显式启用远程访问
后完成配对，并显式启动 `OutboundCompanionRelay` 或向 `CompanionRelayBridge` 绑定
Transport。

## 在 Local Companion Host 中安装

```bash
pnpm add @roll-agent/companion @roll-agent/client-node @roll-agent/relay-protocol
```

## 最小骨架

下面是宿主接线骨架，不是可直接运行的完整 Companion 应用。`workspacePath`、设备/Workspace
身份、`pairingToken`、认证 Transport、本机确认 UI 和进程生命周期都必须由宿主提供。

```ts
import { RollNodeClient } from "@roll-agent/client-node";
import {
  CompanionApprovalRequestBroker,
  CompanionRelayBridge,
  CompanionWorkspace,
  OutboundCompanionRelay,
} from "@roll-agent/companion";
import { deviceIdSchema, workspaceIdSchema } from "@roll-agent/relay-protocol";

const approvalRequestBroker = new CompanionApprovalRequestBroker();
const runtime = await RollNodeClient.start({
  cwd: workspacePath,
  serverRequestHandlers: {
    "approval.request": approvalRequestBroker.handle,
  },
});
const workspaceId = workspaceIdSchema.parse(savedWorkspaceId);
const workspace = new CompanionWorkspace({
  client: runtime,
  approvalRequestBroker,
  localApprovalPolicy: async () => "require-local-confirmation",
});
const bridge = new CompanionRelayBridge({
  deviceId: deviceIdSchema.parse(savedDeviceId),
  pairingToken,
  workspaces: new Map([[workspaceId, workspace]]),
});
const outbound = new OutboundCompanionRelay({
  bridge,
  connectTransport: openAuthenticatedRelayTransport,
});

outbound.start();
```

Browser 与后台 Shell lease 由宿主显式接线；Turn lease 由 `CompanionWorkspace` 管理，
`"1.1"` Approval lease 由 `CompanionApprovalRequestBroker` 的 Handler 生命周期管理。
Browser 通过 Relay 专属 `approval.candidate` 提交候选决定；成功响应
`{ accepted: true }` 只表示本地 Broker 已接受候选，权威终态必须等待有序的
`approval.resolved` Event。候选批准必须重新经过本地 Policy，候选拒绝可以抢占仍在
等待 Policy 的批准并以 deny-wins 收敛；并发批准仍会被拒绝。
`require-local-confirmation` 只会以错误拒绝这次远程批准，不会自动显示本机确认 UI。
Policy 会收到 `{ signal }`，Runtime 取消时该信号同步 abort。返回值严格校验为
`allow | deny | require-local-confirmation`；JavaScript Host 返回其他值时 fail-closed，
不会把批准转发给 Runtime。未知本地异常对 Relay 统一脱敏为
`COMPANION_ERROR / Companion request failed`。

`approval.candidate` 的参数只有 `threadId`、`turnId`、`approvalId`、`decision` 与可选
`reason`，不复用 Runtime mutation 的 UUID `requestId`。Relay envelope 自己的
`requestId` 只负责重投和响应缓存。`"1.0"` 兼容连接继续走
`approval.required` + `approval.respond`；`"1.1"` 上调用后者会 fail closed。
这里的 `"1.0"` / `"1.1"` 指 `RuntimeEventEnvelope.protocolVersion`，不是外层
Companion Relay `"1.0"`。Browser 必须按每个 Runtime Event 的协议版本选择审批方法：
Runtime `"1.0"` 走 `approval.respond`，Runtime `"1.1"` 才走 `approval.candidate`；
滚动升级时不能仅凭 Relay 版本推断该能力。

当前 `@roll-agent/relay-protocol` 只冻结已经存在的 Companion Relay Wire `"1.0"`。
`approval.candidate` 仍是该版本中的 Approval 专属候选方法；通用 typed interaction
request/result/cancelled 以及逻辑 `interactionId` 不属于当前 `"1.0"`，由
[#184](https://github.com/steveoon/roll-agent/issues/184)、
[#187](https://github.com/steveoon/roll-agent/issues/187) 和后续 Relay Wire version
继续设计。

为 Workspace 配置 `RelayPayloadCipher` 后，Runtime request、response 和 event 必须走
`runtime.encrypted`。明文 request 不会进入 Runtime，而会收到加密的
`RELAY_ENCRYPTION_REQUIRED`（`retryable: false`）响应；cipher、密钥管理和 Browser 端
实现由宿主提供。

## 文档

- [`@roll-agent/relay-protocol` Relay v1 参考](https://github.com/steveoon/roll-agent/blob/main/docs/companion-relay-v1-reference.md)
- [使用自己的技术栈接入 Roll](https://github.com/steveoon/roll-agent/blob/main/docs/how-to-build-roll-runtime-ui.md)
- [Runtime Protocol 架构与安全边界](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-architecture.md)
