# `@roll-agent/companion`

连接云端 Web UI 与用户本机 Roll 的 Local Companion / Relay 基础库。

本包提供 Relay 消息 Schema、Workspace 生命周期 lease、事件 ACK/gap 缓冲、mutation
去重、出站重连和可插拔的 Workspace payload cipher。它不包含生产 Cloud Relay Server、
Browser SDK、账号/设备存储、TLS、鉴权授权、本地确认 UI、HA 或监控。

## 安装

```bash
pnpm add @roll-agent/companion @roll-agent/client-node
```

## 最小骨架

```ts
import { RollNodeClient } from "@roll-agent/client-node";
import {
  CompanionRelayBridge,
  CompanionWorkspace,
  OutboundCompanionRelay,
  deviceIdSchema,
  workspaceIdSchema,
} from "@roll-agent/companion";

const runtime = await RollNodeClient.start({ cwd: workspacePath });
const workspaceId = workspaceIdSchema.parse(savedWorkspaceId);
const workspace = new CompanionWorkspace({
  client: runtime,
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

Browser 与后台 Shell lease 由宿主显式接线；Turn 与 Approval lease 由
`CompanionWorkspace` 自动维护。`require-local-confirmation` 只会以错误拒绝这次远程批准，
不会自动显示本机确认 UI。

为 Workspace 配置 `RelayPayloadCipher` 后，Runtime request、response 和 event 必须走
`runtime.encrypted`。明文 request 不会进入 Runtime，而会收到加密的
`RELAY_ENCRYPTION_REQUIRED`（`retryable: false`）响应；cipher、密钥管理和 Browser 端
实现由宿主提供。

## 文档

- [Companion Relay v1 参考](https://github.com/steveoon/roll-agent/blob/main/docs/companion-relay-v1-reference.md)
- [使用自己的技术栈接入 Roll](https://github.com/steveoon/roll-agent/blob/main/docs/how-to-build-roll-runtime-ui.md)
- [Runtime Protocol 架构与安全边界](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-architecture.md)
