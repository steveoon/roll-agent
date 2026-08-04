# 如何用自己的技术栈接入 Roll Agent

## 目标

让 Electron、Tauri、Qt、Python、.NET 或 IDE 扩展通过 `Roll Runtime Protocol v1`
连接本地 Runtime，并让远程 Next.js Web UI 通过 Cloud Relay 与用户本机 Companion
间接访问同一 Runtime。新本地 UI 优先使用 `"1.3"` 的 durable event replay、capability
handshake 与 typed Interaction；旧 UI 可逐级回退 1.2/1.1/1.0。所有第三方接入都不依赖
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
  onUserInputRequest: async (form, { signal }) => {
    return await showLocalUserInputForm(form, { signal });
  },
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
if (
  initialization.protocolVersion !== "1.3" &&
  initialization.protocolVersion !== "1.2" &&
  initialization.protocolVersion !== "1.1"
) {
  await client.shutdown();
  throw new Error(
    "This adapter requires Runtime Protocol 1.3, 1.2 or 1.1; load the separate v1.0 adapter instead",
  );
}
console.log(initialization.runtimeInstanceId);
client.onExit(({ error }) => {
  markRuntimeDisconnected(error);
});

client.onEvent((event) => {
  // 1.3/1.2/1.1 的 approval.required 只负责显示；不能从这里调用 approval.respond。
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
| `"1.3"` | capability ACK 后由 `approval.request` handler 返回 approve/reject | durable `approval.required/resolved` 只读展示与恢复 |
| `"1.2"` | capability ACK 后由 `approval.request` handler 返回 approve/reject | `approval.required` 只读展示；`approval.resolved` 关闭或更新 |
| `"1.1"` | `approval.request` handler 返回 approve/reject | `approval.required` 只读展示；`approval.resolved` 关闭或更新 |
| `"1.0"` | 收到 `approval.required` 后调用 `approval.respond` | Snapshot / Turn 终态 |

`RollNodeClient` 在默认 17 MiB 帧预算下会广告没有强制 handler 的 `"1.3"` / `"1.2"`；
显式配置更低预算时会省略 `"1.3"`。初始化后它发送
`client.capabilities.set`，并在 capability ACK 完成后才让 `start()` / `connect()`
返回；构造时注册的 `approval.request` 会包含在 revision 1 中。动态注册或撤销 handler
会自动递增 revision，撤销还会 abort 该方法的所有未决交互并抑制迟到 Result。

`"1.1"` 当前仍要求在初始化前注册 `approval.request`，否则不会被广告；旧 Runtime
随后回退 `"1.0"`。不要同时实现两条可写 Approval 路径。在 `"1.2"` 或 `"1.1"` 上
调用 `approval.respond` 会返回 `CAPABILITY_UNAVAILABLE`。

上面的示例接受 `"1.3"` / `"1.2"` / `"1.1"`，因此更旧 Runtime 协商到 `"1.0"` 后会关闭
连接并显式失败。需要兼容旧 Runtime 时，按协商结果选择另一个只实现
`approval.required` + `approval.respond` 的 adapter。

Runtime 取消 Approval 时，handler 的 `AbortSignal` 会 abort。对话框必须随之关闭，且
不能发送迟到决定；Client 会自动抑制迟到 Response。人工 Approval 不使用普通
`requestTimeoutMs`，由 Response、Turn 终态、显式 cancel 或连接关闭结束。

1.3/1.2 cancel 使用逻辑 `interactionId`；1.1 保留
`{ serverRequestId, approvalId?, reason }`。JSON-RPC `id`、`interactionId` 与
mutation `params.requestId` 属于三个不同生命周期，不能互换。

### User Input 控制路径

`userInput.request` 是 1.3/1.2 的可选 typed Interaction。只有
`onUserInputRequest`（或等价 typed handler）已完成 capability ACK 时，Runtime 才会把
内建 `roll__user_input` Tool 加入 capability manifest 与 system prompt。表单固定支持
`text | multiline | number | boolean | choice`；用户关闭或按 Esc 应返回正常
`{ status: "cancelled", reason? }`，不能 throw 或取消整个 Turn。

等待期间 1.3/1.2 Snapshot 的 Turn 状态为 `waiting-for-user`，旧协议兼容投影为 `running`。
Handler 的完整 `submitted.values` 只能作为当前 Server Request Result 返回；UI 不得把它们
写入 Runtime Event 日志、诊断或遥测。Runtime 会按原始表单二次校验并重新排序。首版仅允许
`sensitivity: "normal"`，不得用该表单请求 password、token、secret、authentication 或
file picker。

### 连接失败后的 UI 收敛

`onTurnOutcomeUnknown` 与 `onExit` 解决的是两个不同层面：

| 信号 | UI 动作 |
|---|---|
| `onTurnOutcomeUnknown(turnId)` | 清理该 Turn 的 Working/Stop/waiter，保留用户消息和部分输出，不自动重放 |
| `onExit(result)` | 把 Runtime 标为断开；正常 `shutdown()` 也会触发，不能一律显示成崩溃 |

连接仍健康时可直接读取 `thread.snapshot`；连接已退出时，先启动新的 Runtime 并确认
`runtimeInstanceId`。协商到 1.3 时使用 `client.createEventRecovery().resumeThread()`：它会先
暂存并发 live durable event，必要时读取 Snapshot，再请求 `runtime.events.resume`；只有在
收到 `{ throughCursor, replayedCount }` Response barrier 后，才按 cursor 排序、按 eventId
去重并释放 live event。`EVENT_CURSOR_EXPIRED`、`EVENT_CURSOR_GAP`、Runtime 重启或本地
gap 都自动回退 Snapshot。

1.2/1.1/1.0 没有事件 replay，继续调用 `thread.open` / `thread.snapshot` 收敛。Snapshot
响应有分页，messages 与 operations 必须分别遍历自己的 cursor。1.3/1.2 UI 还应从
`pendingInteractions` 恢复安全 Interaction 视图；该投影不包含 JSON-RPC `id`、原始
payload/result 或 secret。Event replay 也不会重建可响应的 Server Request；旧 Approval、
User Input、Tool、Turn 与其他副作用不能自动重放。

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
3. 只有本地入站帧预算至少为 `17 MiB` 时才广告
   `["1.3","1.2","1.1","1.0"]`；预算更低时必须省略 `"1.3"`。若协商到 `"1.3"` 或
   `"1.2"`，立即发送
   `client.capabilities.set({ revision: 1, serverRequestMethods })`，并在 ACK 前保持
   Interaction 不可投递；后续 handler 变更使用严格递增 revision；
4. 同时识别 Runtime 发来的带 `method + id` JSON-RPC Request；收到
   `approval.request` 或 `userInput.request` 后用同一个 JSON-RPC `id` 返回 typed Result；
5. 将 `runtime.event` Notification 分发到 UI；在 `"1.3"` / `"1.2"` / `"1.1"` 中把
   `approval.required` 当作只读 View Event；
6. 处理 `runtime.serverRequest.cancel`：1.3/1.2 按 `interactionId`，1.1 按
   `serverRequestId` 终止本地交互并丢弃迟到结果；
7. 把 stderr 作为日志，不尝试按 JSON 解析；
8. `initialize` 前应用本地入站/出站帧上限；初始化后，出站上限使用本地值与
   `limits.maxFrameBytes` 的较小值。17 MiB 是 1.3 Runtime→Client 入站要求，不是
   Client→Runtime 出站许可；
9. 收到合法但 `id: null` 的 JSON-RPC error 时，不尝试关联挂起请求；把连接视为不可信并
   让所有挂起操作收敛；
10. 1.3 恢复时先暂存 live durable event；逐条接收 replay notification，以 resume Response
    作为 replay→live barrier，再按 cursor 排序并按 eventId 去重；expired/gap 使用
    `{ threadId, limit: 1, recovery: true }` 回退到带 `recoveryProjection: true` 的有界 Snapshot。
    该投影故意不携带 timeline/pending arrays，完整 timeline 另行分页；官方 Node helper 默认
    暂存 10,000 条 / 32 MiB；
11. Runtime 退出后，终止所有未决 Server Request，不自动重放 Approval、User Input、
    `turn.start` 等副作用命令。

Python 标准库示例见
[`examples/python-runtime-client`](../examples/python-runtime-client/README.md)。该示例
有意固定为 N-1 `"1.1"` / `"1.0"` conformance fixture，不是 1.2 capability
handshake 的参考实现。

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
`approval.request` handler 注册，再注入 `CompanionWorkspace`。在 Runtime
`"1.3"` / `"1.2"` / `"1.1"` 下，
`approval.required` 仅作为只读事件转发；Browser/Relay 必须通过 Relay 专属
`approval.candidate` 提交候选决定。成功的 `runtime.response` 只返回
`{ accepted: true }`，表示 Broker 已接受候选；权威终态仍以 `approval.resolved` Event
为准。Broker 会在返回 Runtime Result 前重新执行本地 Policy。远端拒绝只会收窄权限，
可直接返回拒绝。
没有 Broker 的既有 Companion 会协商 `"1.0"`，继续使用独立的 Event +
`approval.respond` fallback。
Browser 的选择依据必须是协商后的 Relay Wire 与 Interaction method。Wire 1.1 使用
`interaction.request/resolved/cancelled` 与 `interaction.candidate`；冻结的 Wire 1.0 只保留
Approval 专属路径。新 Companion 与旧 peer 协商到 1.0 时，不能把 Runtime 1.3/1.2 的
Interaction 或 event cursor 偷渡进旧 registry。

跨 Runtime 与 Relay 接线时，以下标识/游标不能复用：

| 标识或游标 | 所属层 | 用途 |
|---|---|---|
| Runtime JSON-RPC `id` | Runtime ↔ Local Client/Companion | 单次本地连接上的 Request/Response correlation |
| Runtime `interactionId` | Runtime typed Interaction | 同一逻辑交互在显式重投时保持稳定；不承诺跨进程 Server Request 恢复 |
| Relay `requestId` | Browser/Cloud Relay ↔ Companion | Relay request 重投、response correlation 与 Companion 响应缓存 |
| Runtime mutation `params.requestId` | Client/Companion → Runtime | `turn.start` 等 Runtime 写操作幂等 |
| Runtime `eventId` / `eventCursor` | 单 Thread durable event 日志 | 1.3 replay、去重与 Snapshot checkpoint |
| Relay `relaySequence` / ACK | 单 Workspace Relay 投递流 | Relay 重投、ACK 与 gap |

最后一行实际包含两个独立序列空间：

- `RuntimeEventEnvelope.sequence` 只在当前 `runtimeInstanceId` 内递增；1.3 durable event
  使用另一个按 Thread 排序的不透明 cursor；
- Relay `relaySequence`/ACK 只描述 Companion→Relay 的安全投影投递进度，不能拿来 ACK
  Runtime event cursor，也不能从 Runtime sequence/cursor 推导；#176 不增加 Relay 持久
  outbox。

`threadId`、`turnId`、`approvalId` 等是业务对象 ID，不属于上面五类
correlation/幂等/投递标识。

lease 边界如下：

| lease | 获取/释放方式 |
|---|---|
| Browser client | 宿主在认证连接建立/断开时手动调用 `attachBrowser()` / `detachBrowser()` |
| 后台 Shell | 宿主手动调用 `acquireBackgroundShellLease()` 并保存 release 函数 |
| Turn | 只有经 `CompanionWorkspace.startTurn()` 发起时自动获取；终态事件自动释放 |
| Approval | `"1.2"` / `"1.1"` Broker handler 获取，Result/Abort 时释放；`"1.0"` 由 Event fallback 获取和释放 |

浏览器断线不要调用 `thread.detach` 或直接关闭 Runtime。`outbound.stop()` 只终止 Relay、
Bridge 与订阅，不关闭 Runtime；Runtime 生命周期由 `workspace.closeIfIdle()` 单独管理。

`localApprovalPolicy` 返回 `"require-local-confirmation"` 时只会抛出
`LocalConfirmationRequiredError`，不会自动弹窗。宿主必须实现本机确认 UI，并维护只针对
该 Approval 的一次性确认状态。

Relay buffer、ACK、幂等缓存和 lease 都只存在于 Companion 进程内。Companion 重启后必须
重建连接/lease；本地 Runtime 协商到 1.3 时可恢复 durable event，否则用
`thread.snapshot` 收敛 UI。不能把 Relay buffer 当成 Runtime 持久事件日志。

`authentication.request` 与 File Picker 没有远程 projector，保持 local-only。1.3 replay
不会扩大这个边界；未来远程启用必须先完成安全 RFC #186。

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

- 新 Runtime 初始化返回 `"1.3"`，且 `connect()` 返回前完成 capability ACK；
- 动态注册/撤销 handler 会递增 revision；撤销会 abort 未决交互并抑制迟到 Result；
- N-1 Runtime 可回退 `"1.1"`；不支持 Server Request 的旧 Runtime 安全回退 `"1.0"`；
- 创建、列表、打开、重命名、删除和历史分页正常；
- `"1.3"` / `"1.2"` / `"1.1"` 只有 `approval.request` 能决定 Tool 是否执行，`approval.required` 只读；
- `runtime.serverRequest.cancel` 会 abort 本地 handler，`approval.resolved` 收敛 View；
- 上下文压缩后，分页遍历 Snapshot 仍能恢复新格式 Thread 的 transcript；
- Snapshot 不含 `raw` 或 Tool input；
- 1.3 replay 严格遵守 notification → Response barrier → buffered live 顺序，按 eventId 去重；
- cursor expired/gap、Runtime 重启和 replay/live gap 都回退 Snapshot；ephemeral event 不重放；
- Runtime 退出时未终止 Turn 显示 `outcome unknown`；
- UI 对未知结果清理活动态、保留部分输出且不自动重放；
- 非法帧或响应 DTO 会关闭连接并拒绝挂起请求；
- Relay 重复投递不会启动第二个 Turn；
- 远程批准不能绕过本地 Policy；
- cipher-bound Workspace 拒绝明文请求且只返回加密 response/event；
- 浏览器断线后本地长任务继续运行；
- Companion 重启后通过 Runtime 1.3 replay 或 Snapshot 收敛，不依赖旧 Relay ACK/cache/lease。

`roll chat` TUI 不经过上述 stdio Server Request 路径，仍使用原有 `clack` 选择式 Tool
确认；本次协议升级不会改变其可见交互。
