# 如何用自己的技术栈接入 Roll Agent

## 目标

让 Electron、Tauri、Qt、Python、.NET、IDE 扩展或 Next.js Web UI 使用相同的
`Roll Runtime Protocol v1`，而不依赖 `ConversationEngine` 内部 API。

## 本地 Node/Electron 宿主

安装客户端：

```bash
pnpm add @roll-agent/client-node @roll-agent/protocol
```

启动时必须显式提供 Workspace：

```ts
import { randomUUID } from "node:crypto";
import { RollNodeClient } from "@roll-agent/client-node";

const client = await RollNodeClient.start({
  cwd: "/absolute/path/to/workspace",
  requestTimeoutMs: 30_000,
  onStderr: (line) => console.error(`[roll] ${line}`),
  onTurnOutcomeUnknown: (turnId) => {
    console.error(`Turn ${turnId} 的结果未知，请先读取 Snapshot`);
  },
});

console.log(client.getInitializationResult().runtimeInstanceId);
client.onExit(({ error }) => console.error(`Runtime 已退出：${error.message}`));

client.onEvent((event) => {
  renderRuntimeEvent(event);
});

const created = await client.request("thread.create", {
  requestId: randomUUID(),
  title: "My UI",
});

await client.request("turn.start", {
  requestId: randomUUID(),
  threadId: created.thread.id,
  turnId: randomUUID(),
  input: { text: "检查这个项目" },
});
```

`turn.start` 只确认接收，不等待整轮完成。UI 必须继续消费 `runtime.event`，并允许审批、
拒绝和取消并发发生。

Electron 主进程参考见
[`examples/electron-runtime-client`](../examples/electron-runtime-client/README.md)。API Key、
环境变量、子进程句柄和任意文件系统能力都应留在 Main Process。

## Tauri、Qt、Python 或 .NET

启动：

```bash
roll runtime serve --stdio
```

实现以下最小 Transport：

1. 将一条 JSON-RPC Request 写成一行 JSON；
2. 持续读取 stdout，并按 `id` 解析 Response；
3. 将 `runtime.event` Notification 分发到 UI；
4. 把 stderr 作为日志，不尝试按 JSON 解析；
5. 单帧超过 `4 MiB` 时关闭连接并报告协议错误；
6. Runtime 退出后，不自动重放 `turn.start` 等副作用命令。

Python 标准库示例见
[`examples/python-runtime-client`](../examples/python-runtime-client/README.md)。

## 云端 Next.js 控制用户本机 Roll

不要从 Next.js Route Handler 直接启动用户电脑上的 Roll，也不要把本地 RuntimeServer
端口暴露到公网。

使用：

```text
Next.js Browser
    │ authenticated HTTPS/WSS
Cloud Relay
    │ device/workspace routing
Local Companion (outbound connection)
    │ @roll-agent/client-node
roll runtime serve --stdio
```

本地 Companion：

```ts
import { RollNodeClient } from "@roll-agent/client-node";
import {
  CompanionRelayBridge,
  CompanionWorkspace,
  OutboundCompanionRelay,
  createWebSocketRelayTransport,
  deviceIdSchema,
  workspaceIdSchema,
} from "@roll-agent/companion";

const runtime = await RollNodeClient.start({ cwd: workspacePath });
const workspaceId = workspaceIdSchema.parse(savedWorkspaceId);
const workspace = new CompanionWorkspace({
  client: runtime,
  localApprovalPolicy: async (approval) =>
    isHighRisk(approval) ? "require-local-confirmation" : "allow",
});
const bridge = new CompanionRelayBridge({
  deviceId: deviceIdSchema.parse(savedDeviceId),
  pairingToken,
  workspaces: new Map([[workspaceId, workspace]]),
});
const outbound = new OutboundCompanionRelay({
  bridge,
  connectTransport: async () => {
    const socket = await openAuthenticatedWebSocket(relayUrl);
    return createWebSocketRelayTransport(socket);
  },
});
outbound.start();
```

Relay 只负责账号/设备绑定、Workspace 路由、ACK 和重连。Runtime 请求、响应和事件默认不应
持久化。敏感 Workspace 可向 `CompanionRelayBridge` 注入 `RelayPayloadCipher`；密钥必须
只存在于 Browser 与 Companion。

浏览器断线只调用 `workspace.detachBrowser(clientId)`。不要调用 `thread.detach` 或关闭
Runtime；活动 Turn、后台 Shell Session 和待审批操作拥有独立本地 lease。

## 云端运行 Roll

如果 Roll 运行在云端，它只能访问云端 Workspace。多租户部署必须使用：

```text
Tenant / Workspace → isolated Roll Worker → isolated filesystem/secrets
```

Next.js Web/API 保持无状态；不要让多个不可信租户共享同一个 Roll 进程、`ThreadStore`、
环境变量或 Shell。

## 验证清单

- 初始化返回协议 `"1.0"` 和新的 `runtimeInstanceId`；
- 创建、列表、打开、重命名、删除和历史分页正常；
- Tool 审批与取消可在活动 Turn 中执行；
- 上下文压缩后 Snapshot 仍返回完整 transcript；
- Snapshot 不含 `raw` 或 Tool input；
- Runtime 退出时未终止 Turn 显示 `outcome unknown`；
- 非法帧或响应 DTO 会关闭连接并拒绝挂起请求；
- Relay 重复投递不会启动第二个 Turn；
- 远程批准不能绕过本地 Policy；
- 浏览器断线后本地长任务继续运行。
