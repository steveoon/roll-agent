# 如何用自己的技术栈接入 Roll Agent

## 目标

让 Electron、Tauri、Qt、Python、.NET 或 IDE 扩展通过 `Roll Runtime Protocol v1`
连接本地 Runtime，并让远程 Next.js Web UI 通过 Cloud Relay 与用户本机 Companion
间接访问同一 Runtime。新本地 UI 使用 `"1.1"` 的 Runtime→Client Server Request；
没有对应 handler 的既有 UI 继续协商 `"1.0"`。所有第三方接入都不依赖
`ConversationEngine` 内部 API。

## 先选择接入形态

| 产品形态 | 直接依赖 | 是否需要 Companion |
|---|---|---:|
| Local-only Electron/Node GUI | `@roll-agent/client-node`；直接使用 Schema 时再加 `@roll-agent/protocol` | 否 |
| Tauri、Qt、Python、.NET | 自行实现 Runtime Protocol Transport；使用 JSON Schema/fixtures | 否 |
| Browser Web App | `@roll-agent/relay-protocol` | Browser 不安装；用户本机必须运行 Companion Host |
| Cloud Relay Server | `@roll-agent/relay-protocol` | 否 |
| 用户本机 Companion Host | `@roll-agent/companion`、`@roll-agent/client-node`、`@roll-agent/relay-protocol` | 是 |

`@roll-agent/relay-protocol` 是三方共同 Wire 契约，不是 WebSocket Client；
`@roll-agent/companion` 是本机 Host 库，不是 Cloud 服务或安装后自动运行的 daemon。
全局安装 `@roll-agent/core` 不会安装 Companion，也不会自动启用远程访问。

## 本地 Node/Electron 宿主

安装客户端：

```bash
pnpm add @roll-agent/client-node
```

只有直接使用 Schema、协议常量或 DTO 类型时，才需要同时安装
`@roll-agent/protocol`。

宿主还必须确保 `roll` 可执行文件可用。`RollNodeClient.start()` 默认执行
`roll runtime serve --stdio`；产品可以要求用户安装 `@roll-agent/core`，或随应用携带
Runtime 并通过 `command` 指定路径。无论哪种方式，都只启动本地 stdio Runtime，不会启动
Companion 或建立远程连接。

启动时必须显式提供 Workspace：

```ts
import { randomUUID } from "node:crypto";
import { RollNodeClient } from "@roll-agent/client-node";

const client = await RollNodeClient.start({
  cwd: "/absolute/path/to/workspace",
  requestTimeoutMs: 30_000,
  serverRequestHandlers: {
    "approval.request": async ({ approval }, { signal }) => {
      const result = await showLocalApprovalDialog(approval, { signal });
      return result.approved
        ? { decision: "approve" }
        : { decision: "reject", reason: result.reason ?? "用户取消" };
    },
  },
  onStderr: (line) => console.error(`[roll] ${line}`),
  onTurnOutcomeUnknown: (turnId) => {
    stopWorkingState(turnId);
    preservePartialOutput(turnId);
    console.error(`Turn ${turnId} 的结果未知；不要自动重放`);
  },
});

const initialization = client.getInitializationResult();
if (initialization.protocolVersion !== "1.1") {
  await client.shutdown();
  throw new Error(
    "This adapter requires Runtime Protocol 1.1; load the separate v1.0 adapter instead",
  );
}
console.log(initialization.runtimeInstanceId);
client.onExit(({ error }) => {
  markRuntimeDisconnected(error);
});

client.onEvent((event) => {
  // 1.1 的 approval.required 只负责显示；不能从这里调用 approval.respond。
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

### Approval 控制路径

| 协商版本 | 可写控制路径 | View 收敛 |
|---|---|---|
| `"1.1"` | `approval.request` handler 返回 approve/reject | `approval.required` 只读展示；`approval.resolved` 关闭或更新 |
| `"1.0"` | 收到 `approval.required` 后调用 `approval.respond` | Snapshot / Turn 终态 |

`RollNodeClient` 只有在 `start()` / `connect()` 的 `serverRequestHandlers` 中覆盖目标版本
全部必需方法时才广告该版本；`"1.1"` 当前只要求 `approval.request`，否则只广告
`["1.0"]`。不要同时实现两条可写 Approval 路径。在 `"1.1"` 上调用
`approval.respond` 会返回
`CAPABILITY_UNAVAILABLE`。

上面的示例是严格的 `"1.1"` adapter，因此旧 Runtime 协商到 `"1.0"` 后会关闭连接并
显式失败。需要兼容旧 Runtime 时，按协商结果选择另一个只实现
`approval.required` + `approval.respond` 的 adapter。

Runtime 取消 Approval 时，handler 的 `AbortSignal` 会 abort。对话框必须随之关闭，且
不能发送迟到决定；Client 会自动抑制迟到 Response。人工 Approval 不使用普通
`requestTimeoutMs`，由 Response、Turn 终态、显式 cancel 或连接关闭结束。

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
3. 同时识别 Runtime 发来的带 `method + id` JSON-RPC Request；实现审批时广告
   `["1.1","1.0"]`，收到 `approval.request` 后用同一个 `id` 返回 typed Result；
4. 将 `runtime.event` Notification 分发到 UI；在 `"1.1"` 中把
   `approval.required` 当作只读 View Event；
5. 处理 `runtime.serverRequest.cancel`，终止对应本地交互并丢弃迟到结果；
6. 把 stderr 作为日志，不尝试按 JSON 解析；
7. `initialize` 前应用本地入站/出站帧上限；初始化后，出站上限使用本地值与
   `limits.maxFrameBytes` 的较小值；
8. 收到合法但 `id: null` 的 JSON-RPC error 时，不尝试关联挂起请求；把连接视为不可信并
   让所有挂起操作收敛；
9. Runtime 退出后，终止所有未决 Server Request，不自动重放 Approval、
   `turn.start` 等副作用命令。

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

各部署组件分别安装：

| 组件 | 安装 |
|---|---|
| Browser Web App | `pnpm add @roll-agent/relay-protocol` |
| Cloud Relay Server | `pnpm add @roll-agent/relay-protocol` |
| 用户本机 Companion Host | `pnpm add @roll-agent/companion @roll-agent/client-node @roll-agent/relay-protocol` |

下面的依赖和代码属于用户本机 Companion Host，不应放进 Next.js Browser bundle 或 Cloud
Relay Server：

```bash
pnpm add @roll-agent/companion @roll-agent/client-node @roll-agent/relay-protocol
```

本地 Companion 接线骨架：

```ts
import { RollNodeClient } from "@roll-agent/client-node";
import {
  CompanionApprovalRequestBroker,
  CompanionRelayBridge,
  CompanionWorkspace,
  OutboundCompanionRelay,
  createWebSocketRelayTransport,
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

这段代码不是完整的可运行产品。`authenticatedBrowserClientId`、`pairingToken`、
`openAuthenticatedWebSocket()`、设备/Workspace 持久化、本机确认 UI 和 Host 进程生命周期
都必须由产品实现。当前仓库没有 Browser SDK、`roll companion` CLI 或自动启动 daemon。

`@roll-agent/relay-protocol` 是 Browser、Cloud Relay 和 Local Companion 共享的 Wire
契约来源，提供 Relay version、消息/方法注册表、ID Schema、JSON Schema、fixtures 与
TypeScript types。`@roll-agent/companion` 只消费该契约，并提供本机的
`CompanionWorkspace`、Relay bridge、Approval Policy、主动出站重连和 WebSocket 文本
adapter；它不包含生产 Cloud Relay Server。

账号/设备绑定、鉴权授权、TLS、Browser SDK、持久配对、心跳、帧上限、HA、监控和协议诊断
都由生产宿主实现。Browser 或 Cloud Relay 不应为了校验 Wire frame 而依赖
`@roll-agent/companion`。

`CompanionApprovalRequestBroker` 必须在 `RollNodeClient.start()` 前创建并作为
`approval.request` handler 注册，再注入 `CompanionWorkspace`。在 `"1.1"` 下，
`approval.required` 仅作为只读事件转发；Browser/Relay 必须通过 Relay 专属
`approval.candidate` 提交候选决定。成功的 `runtime.response` 只返回
`{ accepted: true }`，表示 Broker 已接受候选；权威终态仍以 `approval.resolved` Event
为准。Broker 会在返回 Runtime Result 前重新执行本地 Policy。远端拒绝只会收窄权限，
可直接返回拒绝。
没有 Broker 的既有 Companion 会协商 `"1.0"`，继续使用独立的 Event +
`approval.respond` fallback。
Browser 的选择依据必须是收到的 `RuntimeEventEnvelope.protocolVersion`，不是外层
Companion Relay 的 `"1.0"`：Runtime `"1.0"` 使用 `approval.respond`，Runtime `"1.1"`
使用 `approval.candidate`。这也是新 Browser 与旧 Companion 滚动升级时的 fallback
边界。

当前 Relay 契约只冻结 Wire `"1.0"`。其中的 `approval.candidate` 是 Approval 专属能力，
不是通用交互抽象。未来的 typed interaction request/result/cancelled 与逻辑
`interactionId` 由 [#184](https://github.com/steveoon/roll-agent/issues/184)、
[#187](https://github.com/steveoon/roll-agent/issues/187) 及后续 Relay Wire version
承载；不能在不升级 Relay version 的情况下把它们塞进 `"1.0"`。

跨 Runtime 与 Relay 接线时，以下五类标识/游标不能复用：

| 标识或游标 | 所属层 | 用途 |
|---|---|---|
| Runtime JSON-RPC `id` | Runtime ↔ Local Client/Companion | 单次本地连接上的 Request/Response correlation |
| `interactionId` | 未来 typed interaction | 跨投递、重连与恢复的逻辑交互身份；当前 Relay `"1.0"` 尚无此字段 |
| Relay `requestId` | Browser/Cloud Relay ↔ Companion | Relay request 重投、response correlation 与 Companion 响应缓存 |
| Runtime mutation `params.requestId` | Client/Companion → Runtime | `turn.start` 等 Runtime 写操作幂等 |
| `sequence` / cursor | Runtime event 或 Relay delivery | 各自在自己的序列空间内排序、恢复和 ACK |

最后一行实际包含两个独立序列空间：

- `RuntimeEventEnvelope.sequence` 只在当前 `runtimeInstanceId` 内递增，由
  `thread.snapshot` 负责状态恢复；
- Relay `relaySequence`/ACK cursor 只描述 Companion→Relay 的投递进度，不能拿来 ACK
  Runtime event cursor，也不能从 Runtime sequence 推导。

`threadId`、`turnId`、`approvalId` 等是业务对象 ID，不属于上面五类
correlation/幂等/投递标识。

lease 边界如下：

| lease | 获取/释放方式 |
|---|---|
| Browser client | 宿主在认证连接建立/断开时手动调用 `attachBrowser()` / `detachBrowser()` |
| 后台 Shell | 宿主手动调用 `acquireBackgroundShellLease()` 并保存 release 函数 |
| Turn | 只有经 `CompanionWorkspace.startTurn()` 发起时自动获取；终态事件自动释放 |
| Approval | `"1.1"` Broker handler 获取，Result/Abort 时释放；`"1.0"` 由 Event fallback 获取和释放 |

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
[`@roll-agent/relay-protocol` Relay v1 参考](./companion-relay-v1-reference.md)。

## 云端运行 Roll

如果 Roll 运行在云端，它只能访问云端 Workspace。多租户部署必须使用：

```text
Tenant / Workspace → isolated Roll Worker → isolated filesystem/secrets
```

Next.js Web/API 保持无状态；不要让多个不可信租户共享同一个 Roll 进程、`ThreadStore`、
环境变量或 Shell。

## 验证清单

- 注册 Approval handler 时初始化返回 `"1.1"`；没有 handler 时安全回退 `"1.0"`；
- 创建、列表、打开、重命名、删除和历史分页正常；
- `"1.1"` 只有 `approval.request` 能决定 Tool 是否执行，`approval.required` 只读；
- `runtime.serverRequest.cancel` 会 abort 本地 handler，`approval.resolved` 收敛 View；
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

`roll chat` TUI 不经过上述 stdio Server Request 路径，仍使用原有 `clack` 选择式 Tool
确认；本次协议升级不会改变其可见交互。
