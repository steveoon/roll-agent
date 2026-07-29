# 如何用自己的技术栈接入 Roll Agent

## 目标

让 Electron、Tauri、Qt、Python、.NET、IDE 扩展或 Next.js Web UI 使用相同的
`Roll Runtime Protocol v1`，而不依赖 `ConversationEngine` 内部 API。

## 本地 Node/Electron 宿主

安装客户端：

```bash
pnpm add @roll-agent/client-node
```

只有直接使用 Schema、协议常量或 DTO 类型时，才需要同时安装
`@roll-agent/protocol`。

启动时必须显式提供 Workspace：

```ts
import { randomUUID } from "node:crypto";
import { RollNodeClient } from "@roll-agent/client-node";

const client = await RollNodeClient.start({
  cwd: "/absolute/path/to/workspace",
  requestTimeoutMs: 30_000,
  onStderr: (line) => console.error(`[roll] ${line}`),
  onTurnOutcomeUnknown: (turnId) => {
    stopWorkingState(turnId);
    preservePartialOutput(turnId);
    console.error(`Turn ${turnId} 的结果未知；不要自动重放`);
  },
});

console.log(client.getInitializationResult().runtimeInstanceId);
client.onExit(({ error }) => {
  markRuntimeDisconnected(error);
});

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

async function shutdownApplication() {
  // 在应用退出钩子中调用，并等待真实子进程退出。
  await client.shutdown();
}
```

`turn.start` 只确认接收，不等待整轮完成。UI 必须继续消费 `runtime.event`，并允许审批、
拒绝和取消并发发生；只用同时匹配目标 `threadId + turnId` 的终止事件结束对应 Turn。

### 连接失败后的 UI 收敛

`onTurnOutcomeUnknown` 与 `onExit` 解决的是两个不同层面：

| 信号 | UI 动作 |
|---|---|
| `onTurnOutcomeUnknown(turnId)` | 清理该 Turn 的 Working/Stop/waiter，保留用户消息和部分输出，不自动重放 |
| `onExit(result)` | 把 Runtime 标为断开；正常 `shutdown()` 也会触发，不能一律显示成崩溃 |

连接仍健康时可直接读取 `thread.snapshot`；连接已退出时，先启动新的 Runtime、确认新的
`runtimeInstanceId`，再调用 `thread.open` / `thread.snapshot` 收敛。Snapshot 的数据源是
追加式 transcript，但响应有分页；messages 与 operations 必须分别遍历自己的 cursor。

Electron 主进程参考见
[`examples/electron-runtime-client`](../examples/electron-runtime-client/README.md)。API Key、
环境变量、子进程句柄和任意文件系统能力都应留在 Main Process。

完整生命周期、错误类与重试规则见
[`@roll-agent/client-node` API 参考](./client-node-reference.md)。

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
5. `initialize` 前应用本地入站/出站帧上限；初始化后，出站上限使用本地值与
   `limits.maxFrameBytes` 的较小值；
6. 收到合法但 `id: null` 的 JSON-RPC error 时，不尝试关联挂起请求；把连接视为不可信并
   让所有挂起操作收敛；
7. Runtime 退出后，不自动重放 `turn.start` 等副作用命令。

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

安装本地桥接包：

```bash
pnpm add @roll-agent/companion @roll-agent/client-node
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

// clientId 必须来自宿主已经认证的 Browser 连接控制面。
const clientId = authenticatedBrowserClientId;
const releaseBrowserLease = workspace.attachBrowser(clientId);

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

function onAuthenticatedBrowserDisconnected() {
  // 等价于 workspace.detachBrowser(clientId)。
  releaseBrowserLease();
}

async function shutdownCompanionHost() {
  // stop() 是终态、同步操作；Runtime 仅在所有 lease 清空后关闭。
  outbound.stop();
  await workspace.closeIfIdle();
}
```

`@roll-agent/companion` 当前提供本机的 `CompanionWorkspace`、Relay bridge、主动出站重连
和 WebSocket 文本 adapter；它不包含生产 Cloud Relay Server。账号/设备绑定、鉴权授权、
TLS、Browser SDK、持久配对、心跳、帧上限、HA、监控和协议诊断都由生产宿主实现。

lease 边界如下：

| lease | 获取/释放方式 |
|---|---|
| Browser client | 宿主在认证连接建立/断开时手动调用 `attachBrowser()` / `detachBrowser()` |
| 后台 Shell | 宿主手动调用 `acquireBackgroundShellLease()` 并保存 release 函数 |
| Turn | 只有经 `CompanionWorkspace.startTurn()` 发起时自动获取；终态事件自动释放 |
| Approval | `approval.required` 自动获取；响应完成或 Turn 终态自动释放 |

浏览器断线不要调用 `thread.detach` 或直接关闭 Runtime。`outbound.stop()` 只终止 Relay、
Bridge 与订阅，不关闭 Runtime；Runtime 生命周期由 `workspace.closeIfIdle()` 单独管理。

`localApprovalPolicy` 返回 `"require-local-confirmation"` 时只会抛出
`LocalConfirmationRequiredError`，不会自动弹窗。宿主必须实现本机确认 UI，并维护只针对
该 Approval 的一次性确认状态。

事件缓冲、ACK、sequence、幂等缓存和 lease 都只存在于 Companion 进程内。Companion 重启
后必须重建连接/lease，并用 `thread.snapshot` 收敛 UI；不能把 Relay buffer 当成持久日志。

敏感 Workspace 可向 `CompanionRelayBridge` 注入 `RelayPayloadCipher`。一旦绑定 cipher：

- 明文 `runtime.request` 会在触达 Runtime 前被拒绝，稳定错误为
  `RELAY_ENCRYPTION_REQUIRED` 且 `retryable: false`；
- 请求必须使用 `runtime.encrypted`，response/event 也只以加密信封发送；
- Relay 仍可读取 Workspace、payload kind、request ID 或 sequence 等路由元数据；
- 算法、AEAD、nonce、密钥协商/轮换、Browser 实现和密钥存储由宿主负责。

完整消息、缓存、lease 和关闭语义见
[`@roll-agent/companion` Relay v1 参考](./companion-relay-v1-reference.md)。

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
- 上下文压缩后，分页遍历 Snapshot 仍能恢复新格式 Thread 的 transcript；
- Snapshot 不含 `raw` 或 Tool input；
- Runtime 退出时未终止 Turn 显示 `outcome unknown`；
- UI 对未知结果清理活动态、保留部分输出且不自动重放；
- 非法帧或响应 DTO 会关闭连接并拒绝挂起请求；
- Relay 重复投递不会启动第二个 Turn；
- 远程批准不能绕过本地 Policy；
- cipher-bound Workspace 拒绝明文请求且只返回加密 response/event；
- 浏览器断线后本地长任务继续运行；
- Companion 重启后通过 Snapshot 收敛，不依赖旧 ACK/cache/lease。
