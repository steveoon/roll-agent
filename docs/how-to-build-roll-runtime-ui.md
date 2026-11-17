# 如何用自己的技术栈接入 Roll Agent

## 目标

让 Electron、Tauri、Qt、Python、.NET 或 IDE 扩展通过 `Roll Runtime Protocol v1`
连接本地 Runtime，并让远程 Next.js Web UI 通过 Cloud Relay 与用户本机 Companion
间接访问同一 Runtime。新本地 UI 优先使用最新 `"1.6"`（及 `1.3–1.5`）的持久事件恢复、
客户端能力握手、类型化交互、附件、结构化应用输出（App output）与上下文恢复视图；
连接旧版 Runtime 时可逐级回退至 `1.2`、`1.1` 或 `1.0`。所有第三方接入均不依赖
`ConversationEngine` 内部 API。

## 先选择接入形态

| 产品形态 | 直接依赖 | 是否需要 Companion |
|---|---|---:|
| Local-only Electron/Node GUI | `@roll-agent/client-node`；使用能力查询、Schema 或 DTO 类型时加装 `@roll-agent/protocol` | 否 |
| Tauri、Qt、Python、.NET | 自行实现 Runtime Protocol Transport；使用 JSON Schema/fixtures | 否 |
| Browser Web App | `@roll-agent/relay-client` | Browser 不安装本机组件；用户电脑必须运行官方 Companion |
| Cloud Relay Server | `@roll-agent/relay-protocol` | 否 |
| 用户本机 Companion Host | 官方 `roll companion` 服务 | 是 |

`@roll-agent/relay-protocol` 定义 Relay 的 Wire 与 Control 契约，普通 Web App 无需直接处理。
`@roll-agent/companion` 是供官方宿主调用的底层通信库，普通第三方产品无需自行用它拼装本机宿主。
单独安装 `@roll-agent/core` 也不会自动完成设备注册（enrollment）或开启远程访问。

## 本地 Node/Electron 宿主

安装客户端与协议包：

```bash
pnpm add @roll-agent/client-node @roll-agent/protocol
```

若不直接调用 `getRuntimeProtocolCapabilities()`、Schema 或协议常量/类型，也可仅安装
`@roll-agent/client-node`。

宿主还必须确保 `roll` 可执行文件可用。`RollNodeClient.start()` 默认执行
`roll runtime serve --stdio`；产品可以要求用户安装 `@roll-agent/core`，或随应用携带
Runtime 并通过 `command` 指定路径。无论哪种方式，都只启动本地 stdio Runtime，不会启动
Companion 或建立远程连接。

启动时必须显式提供 Workspace：

```ts
import { randomUUID } from "node:crypto";
import { RollNodeClient } from "@roll-agent/client-node";
import { getRuntimeProtocolCapabilities } from "@roll-agent/protocol";

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
if (!getRuntimeProtocolCapabilities(initialization.protocolVersion).serverRequests) {
  await client.shutdown();
  throw new Error(
    `This adapter requires a Runtime Protocol version with Server Request support (1.1 or newer, negotiated ${initialization.protocolVersion}); load the separate v1.0 adapter instead`,
  );
}
console.log(initialization.runtimeInstanceId);
client.onExit(({ error }) => {
  markRuntimeDisconnected(error);
});

client.onEvent((event) => {
  // 1.1–1.6 的 approval.required 仅用于只读展示；切勿在此调用 approval.respond。
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
| `"1.6"` / `"1.5"` / `"1.4"` / `"1.3"` | 完成 capability ACK 后，由 `approval.request` handler 返回 `approve` / `reject` | durable `approval.required` / `approval.resolved` 只读展示与持久事件恢复 |
| `"1.2"` | 完成 capability ACK 后，由 `approval.request` handler 返回 `approve` / `reject` | `approval.required` 只读展示；`approval.resolved` 关闭或更新状态 |
| `"1.1"` | 由 `approval.request` handler 返回 `approve` / `reject` | `approval.required` 只读展示；`approval.resolved` 关闭或更新状态 |
| `"1.0"` | 收到 `approval.required` 后调用 `approval.respond` | Snapshot / Turn 终态 |

在默认的 `17 MiB` 帧预算下，`RollNodeClient` 会广告无需前置强制 handler 的
`"1.6"`、`"1.5"`、`"1.4"`、`"1.3"` 与 `"1.2"`；若显式配置低于 `17 MiB` 的预算，则会一并省略
`1.3–1.6`（即 `"1.6"`、`"1.5"`、`"1.4"` 与 `"1.3"`）。协商到 `1.2–1.6` 后，客户端会自动发送
`client.capabilities.set`，并等待 Runtime 完成 capability ACK 后才让 `start()` / `connect()`
返回；构造时传入的 `approval.request` 会包含在首个 `revision: 1` 声明中。运行期动态注册或撤销
handler 时会自动递增 `revision`，撤销能力还会立即中止该方法下所有未决交互并屏蔽迟到的返回值。

`"1.1"` 仍要求在初始化前注册 `approval.request`，否则不会被广告，连接旧版 Runtime 时将直接回退至
`"1.0"`。切勿为同一次审批同时挂载两条可写路径；在 `1.1–1.6` 上调用 `approval.respond` 会返回
`CAPABILITY_UNAVAILABLE`。

上面的示例通过 `getRuntimeProtocolCapabilities(...).serverRequests` 接受 `1.1–1.6`，因此连接仅支持
`"1.0"` 的旧版 Runtime 时会主动关闭连接并报错。若产品必须兼容 `"1.0"`，应按协商版本切换到独立的
`approval.required` + `approval.respond` 适配器。

Runtime 生成的 Approval 截止时间为 `min(now + 5 minutes, Turn 剩余期限)`；`1.2–1.6` 的
`expiresAt` 是绝对截止时间，进程内显式重投不会延长它。Runtime 取消通知、客户端撤销能力或连接关闭
都会触发 handler 的 `AbortSignal`；本地审批弹窗必须随之关闭，且不得再提交迟到决定，客户端也会
自动拦截迟到响应。人工审批不受普通 `requestTimeoutMs` 限制，仅在返回结果、到达截止时间、Turn
进入终态、收到显式取消、撤销能力或关闭连接时结束。

`1.2–1.6` 的取消通知使用逻辑 `interactionId`；`1.1` 保留
`{ serverRequestId, approvalId?, reason }`。JSON-RPC `id`、`interactionId` 与
写操作幂等键 `params.requestId` 分属三个独立生命周期，不能互换。

### User Input 控制路径

`userInput.request` 是 `1.2–1.6` 的可选类型化交互。只有当
`onUserInputRequest`（或等价类型化 handler）完成 capability ACK 后，Runtime 才会将内建
`roll__user_input` Tool 注入 capability manifest 与 system prompt。表单控件类型固定为
`text | multiline | number | boolean | choice`；用户关闭弹窗或按 Esc 取消时，应正常返回
`{ status: "cancelled", reason? }`，不应抛出异常或取消整个 Turn。

等待用户输入期间，`1.2–1.6` Snapshot 的 Turn 状态为 `waiting-for-user`，向旧协议投影时兼容映射为
`running`。Handler 提交的完整 `submitted.values` 仅作为当次 Server Request 的结果返回；UI 不得将其
写入 Runtime Event 日志、诊断信息或遥测数据。Runtime 会对照原始表单定义做二次校验并按控件顺序规范化。
当前仅允许 `sensitivity: "normal"`，不得用该表单采集密码、令牌、密钥、身份凭据或本地文件路径。

### 连接失败后的 UI 收敛

`onTurnOutcomeUnknown` 与 `onExit` 分别处理不同层面的状态收敛：

| 信号 | UI 动作 |
|---|---|
| `onTurnOutcomeUnknown(turnId)` | 结束该 Turn 的运行态指示、停止按钮与等待器，保留用户消息和已生成的部分输出，不自动重放 |
| `onExit(result)` | 将 Runtime 标记为已断开；正常调用 `shutdown()` 也会触发该回调，不应一律提示为异常崩溃 |

连接仍健康时可直接读取 `thread.snapshot`；连接已退出时，先启动新的 Runtime 并确认新的
`runtimeInstanceId`。协商到 `1.3–1.6` 时，使用 `client.createEventRecovery().resumeThread()`：
它会先暂存并发到达的实时 durable event，必要时拉取恢复快照，再调用 `runtime.events.resume`；
仅在收到 `{ throughCursor, replayedCount }` 响应屏障后，才按 `cursor` 排序、按 `eventId`
去重并释放暂存的实时事件。遇到 `EVENT_CURSOR_EXPIRED`、`EVENT_CURSOR_GAP`、Runtime 重启或本地
序列缺口时，管理器会自动回退到 Snapshot。

`1.0–1.2` 不支持事件重放，仍通过 `thread.open` / `thread.snapshot` 收敛。Snapshot
响应采用独立分页，`messages` 与 `operations` 必须分别遍历各自的游标。`1.2–1.6` UI 还应从
`pendingInteractions` 恢复未决的安全交互视图（不含 JSON-RPC `id`、原始载荷/结果或敏感信息）；
`1.6` Snapshot 额外提供 `contextRecovery` 上下文恢复门禁状态，`1.5–1.6` 的 Operation 携带
`appOutput` 描述符（完整结构化输出通过 `operation.result.get` 按需拉取）。事件重放不会重建可响应的
Server Request；旧的审批、用户输入、工具调用与 Turn 等副作用均不得自动重放。

Electron 主进程参考见
[`examples/electron-runtime-client`](../examples/electron-runtime-client/README.md)。API Key、
环境变量、子进程句柄和任意文件系统能力都应留在 Main Process。

完整生命周期、错误类与重试规则见
[`@roll-agent/client-node` API 参考](./client-node-reference.md)。

## Tauri、Qt、Python 或 .NET

启动本地服务：

```bash
roll runtime serve --stdio
```

按以下契约实现最小 Transport：

1. 将每条 JSON-RPC Request 序列化为单行 JSON（NDJSON）写入 stdin；
2. 持续按行读取 stdout，并按 `id` 关联响应；
3. 仅当本地入站帧预算不少于 `17 MiB` 时，才可广告
   `["1.6", "1.5", "1.4", "1.3", "1.2", "1.1", "1.0"]`；若预算低于 `17 MiB`，必须同时省略
   `"1.6"`、`"1.5"`、`"1.4"` 与 `"1.3"`。协商到 `1.2–1.6` 后，必须立即发送
   `client.capabilities.set({ revision: 1, serverRequestMethods })`，并将收到的 ACK 响应作为可接收交互请求的就绪屏障；后续变更 handler 时须使用严格递增的 `revision`。Runtime 返回的已接受方法列表可能是空集或请求列表的任意子集（顺序以 Runtime 注册表为准），客户端应按集合语义应用该结果。仅当 `revision` 不匹配或返回了未曾请求的方法时才视为协议违例；未被接受的方法不得在本地分发，若 Runtime 仍发来该请求应直接返回 `-32601`；
4. 同时识别 Runtime 发来的带 `method + id` 的 JSON-RPC Request；收到
   `approval.request` 或 `userInput.request` 后，使用同一个 JSON-RPC `id` 返回类型化结果；
5. 将 `runtime.event` Notification 分发给 UI；在 `1.1–1.6` 中将 `approval.required` 视为只读视图事件；
6. 处理 `runtime.serverRequest.cancel`：`1.2–1.6` 按 `interactionId`、`1.1` 按 `serverRequestId`
   中止本地交互，并丢弃迟到的处理结果；
7. 将 stderr 仅作为诊断日志逐行读取，不要按 JSON 解析；
8. 在 `initialize` 前启用本地入站/出站帧字节上限；初始化完成后，出站帧上限取本地上限与
   `limits.maxFrameBytes` 的较小值。`17 MiB` 是 `1.3–1.6` 对 Runtime→Client 入站帧的最低要求，
   并非允许 Client→Runtime 发送同等大小出站帧的额度；
9. 收到合法但 `id: null` 的 JSON-RPC error 时，不要尝试猜测归属请求；应将该连接视为不可信并使所有挂起操作进入终止收敛；
10. 在 `1.3–1.6` 下执行恢复时，先暂存并发实时 durable event，再逐条接收重放通知，以
    `runtime.events.resume` 的响应作为“重放→实时”切换屏障，随后按 `cursor` 排序并按 `eventId` 去重；
    若游标过期或出现缺口，调用 `{ threadId, limit: 1, recovery: true }` 回退到带
    `recoveryProjection: true` 的有界恢复快照。该恢复投影不携带历史时间线与待处理列表，完整历史需另行分页拉取；官方 Node 恢复管理器默认暂存上限为 `10,000` 条或 `32 MiB`；
11. Runtime 进程退出后，立即终止所有未决 Server Request，切勿自动重放审批、用户输入、`turn.start` 等具有副作用的请求。

Python 标准库示例见
[`examples/python-runtime-client`](../examples/python-runtime-client/README.md)。该示例有意固定为
`"1.1"` / `"1.0"` 兼容性夹具，并非 `1.2+` 客户端能力握手的参考实现。

## 云端 Next.js 控制用户本机 Roll

普通第三方应用应直接参考[远程 Web App 接入指南](./how-to-connect-remote-web-app.md)：前端只需依赖
`@roll-agent/relay-client`，后端只需实现短期 Browser Session 兑换接口，用户电脑侧由官方
`roll companion` 托管。下方代码仅面向需要了解底层桥接机制的 Roll / Relay 维护者，并非普通 Web App 的接入方式。

切勿从 Next.js Route Handler 直接尝试启动用户电脑上的 Roll，也不要把本地 `RuntimeServer`
暴露到公网端口。

标准拓扑如下：

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
| Browser Web App | `pnpm add @roll-agent/relay-client` |
| Cloud Relay Server | `pnpm add @roll-agent/relay-protocol` |
| 官方 Companion 开发安装 | `pnpm add -g @roll-agent/core` |

下面的依赖和代码属于用户本机 Companion Host，不应打包进 Next.js 浏览器产物或部署到 Cloud Relay Server：

```bash
pnpm add @roll-agent/companion @roll-agent/client-node @roll-agent/relay-protocol @roll-agent/protocol
```

本地 Companion 接线骨架（对齐官方 `companion-host` 策略）：

```ts
import { RollNodeClient } from "@roll-agent/client-node";
import {
  CompanionInteractionBroker,
  CompanionRelayBridgeV11,
  CompanionWorkspace,
  OutboundCompanionRelayV11,
  createRuntimeServerRequestHandlers,
  createWebSocketRelayTransportV11,
} from "@roll-agent/companion";
import { getRuntimeProtocolCapabilities } from "@roll-agent/protocol";
import {
  RELAY_REQUEST_METHODS_V12,
  deviceIdSchema,
  workspaceIdSchema,
  type RelayRequestMethodV12,
} from "@roll-agent/relay-protocol";

const P0_REMOTE_METHODS = new Set<RelayRequestMethodV12>([
  RELAY_REQUEST_METHODS_V12.threadList,
  RELAY_REQUEST_METHODS_V12.threadCreate,
  RELAY_REQUEST_METHODS_V12.threadOpen,
  RELAY_REQUEST_METHODS_V12.threadSnapshot,
  RELAY_REQUEST_METHODS_V12.threadCapabilities,
  RELAY_REQUEST_METHODS_V12.turnStart,
  RELAY_REQUEST_METHODS_V12.turnCancel,
  RELAY_REQUEST_METHODS_V12.operationGet,
  RELAY_REQUEST_METHODS_V12.operationResultGet,
  RELAY_REQUEST_METHODS_V12.interactionCandidate,
]);

const interactionBroker = new CompanionInteractionBroker();
const runtime = await RollNodeClient.start({
  cwd: workspacePath,
  serverRequestHandlers: createRuntimeServerRequestHandlers(interactionBroker),
});
if (!getRuntimeProtocolCapabilities(runtime.getInitializationResult().protocolVersion).serverRequests) {
  await runtime.shutdown();
  throw new Error("Runtime Protocol 1.1 or newer is required for Relay Wire 1.1+");
}
const workspaceId = workspaceIdSchema.parse(savedWorkspaceId);
const workspace = new CompanionWorkspace({
  client: runtime,
  workspaceId,
  interactionBroker,
  // 每次查询动态读取本机授权列表，决定是否允许远端读取指定工具的 appOutput。
  remoteAppOutputPolicy: async (agentName, toolName) =>
    isRemoteAppOutputGranted(workspaceId, agentName, toolName),
  // Runtime 的 runtime.approval 是唯一审批事实源；官方 P0 不增加电脑端二次确认。
  localApprovalPolicy: () => "allow",
});

// clientId 必须来自宿主已经认证的 Browser 连接控制面。
const clientId = authenticatedBrowserClientId;
const releaseBrowserLease = workspace.attachBrowser(clientId);

const bridge = new CompanionRelayBridgeV11({
  deviceId: deviceIdSchema.parse(savedDeviceId),
  pairingToken,
  // 官方 Companion 默认使用 Wire "1.2"；当 Relay 部署同步支持时可显式传入 "1.3"。
  protocolVersion: "1.2",
  workspaces: new Map([[workspaceId, workspace]]),
});
const requestPolicy = async ({ workspaceId: requestedWorkspaceId, method, signal }) =>
  !signal.aborted &&
  requestedWorkspaceId === workspaceId &&
  P0_REMOTE_METHODS.has(method);
const outbound = new OutboundCompanionRelayV11({
  bridge,
  connectTransport: async () => {
    const socket = await openAuthenticatedWebSocket(relayUrl);
    return {
      transport: createWebSocketRelayTransportV11(socket),
      responderContext: authenticatedRelaySession,
      requestPolicy,
      responderPolicy: async ({ responderContext, signal }) =>
        authorizeInteractionResponder(responderContext, { signal }),
    };
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

以上骨架仅展示协议装配方式，并非完整产品。`authenticatedBrowserClientId`、
`authenticatedRelaySession`、`authorizeInteractionResponder()`、`isRemoteAppOutputGranted()`、
`pairingToken`、`openAuthenticatedWebSocket()`、设备与 Workspace 绑定持久化以及宿主进程守护，
均须由宿主自行实现。其中 `responderContext` 是由宿主自行维护的不透明上下文对象，Companion
本身不会解析其内容，也不会据此完成身份认证或控制权（controller）选举。普通应用无需复制这套装配，直接使用
`@roll-agent/relay-client` 与官方 `roll companion` CLI / 后台服务即可。

`@roll-agent/relay-protocol` 是 Browser、Cloud Relay 和 Local Companion 共享的契约包，提供
Relay 版本注册表、消息/方法定义、ID Schema、JSON Schema、fixtures 与 TypeScript 类型。
`@roll-agent/companion` 消费该契约，提供本机侧的 `CompanionWorkspace`、Interaction Broker、
Relay Wire `1.1–1.3` 桥接器（`CompanionRelayBridgeV11`）、本地审批与 `appOutput` 门禁策略、主动出站重连以及
WebSocket 文本帧适配器；它不包含生产级 Cloud Relay 服务端。

账号/设备绑定、鉴权授权、TLS、Browser Session、心跳、帧上限、高可用、监控与协议诊断均由独立的
Cloud Relay 服务实现。Browser 或 Cloud Relay 校验 Wire 帧时应直接依赖 `@roll-agent/relay-protocol`，
不应引入 `@roll-agent/companion`。

`CompanionInteractionBroker` 必须在 `RollNodeClient.start()` 之前创建，通过
`createRuntimeServerRequestHandlers()` 注册 `approval.request` 与 `userInput.request`，再注入
`CompanionWorkspace`。它负责处理 Runtime `1.2–1.6` 的类型化交互，同时也为 Runtime `1.1` 的
Approval 提供兼容适配层（官方捆绑的 `roll companion` 要求本地 Runtime 协商到最新协议 `"1.6"`）。
`1.2–1.6` 未被接受的方法不会对外暴露，遇到意外请求时返回 `-32601`；`1.1` 缺少
`approval.request` handler 时客户端不会广告 `"1.1"`，而是回退至 `"1.0"`。面向远端的 `V11`
宿主必须像示例一样拒绝 Runtime `"1.0"` 等缺乏类型化审批控制路径的组合，不得从时间线事件拼凑审批结果。
旧版 `CompanionApprovalRequestBroker` 已弃用，新代码应统一使用 `CompanionInteractionBroker`。

Browser 的控制路径由协商出的 Relay Wire 版本决定：

- **Wire `1.1–1.3`**：统一使用 `interaction.request` / `interaction.resolved` / `interaction.cancelled`
  与 `interaction.candidate`。`runtime.response` 返回 `{ accepted: true }` 仅代表本机 Broker 已接收并结算该候选；Browser 仍须等待有序的 `interaction.resolved` 或 `interaction.cancelled` 来收敛界面状态，不能据此推断工具已经执行。远端提交的 `approve` 在写回 Runtime 前仍会经过本地审批策略校验，而 `reject` 仅收窄权限。
- **Wire `1.2`**：在 `1.1` 基础上新增按需查询结构化输出的 `operation.result.get`，并在
  `OperationView` 与 `tool.completed` 中附带轻量的 `appOutput` 描述符（由 `CompanionWorkspace` 的
  `remoteAppOutputPolicy` 按每次查询动态授权）。官方 `roll companion` 默认使用 Wire `"1.2"`。
- **Wire `1.3`**：在 `1.2` 基础上为 Snapshot 新增可空的 `contextRecovery` 字段，并在事件流中转发
  `context.recovery.changed`。当云端 Relay 与本机 Companion 同步支持时可显式开启 `"1.3"`。
- **冻结的 Wire `1.0`**：仅保留旧版 Approval 专属路径，未按远程威胁模型做脱敏投影，仅限处于同等本地信任边界内的旧版对端使用。面向 Cloud / Browser 的生产宿主必须协商 Wire `1.1` 及以上版本，协商失败时直接拒绝连接，严禁将 Runtime `1.2–1.6` 的交互、事件游标或原始 Runtime 结果降级塞入 Wire `1.0`。

跨 Runtime 与 Relay 接线时，以下标识与游标严禁混用：

| 标识或游标 | 所属层 | 用途 |
|---|---|---|
| Runtime JSON-RPC `id` | Runtime ↔ Local Client/Companion | 单次本地连接上的请求/响应关联 |
| Runtime `interactionId` | Runtime typed Interaction | 同一逻辑交互在进程内显式重投时保持稳定；不提供跨进程恢复 |
| Relay `requestId` | Browser/Cloud Relay ↔ Companion | Relay 请求重投、响应关联与 Companion 幂等响应缓存 |
| Runtime mutation `params.requestId` | Client/Companion → Runtime | `turn.start` 等 Runtime 写操作的幂等键 |
| Runtime `eventId` / `eventCursor` | 单 Thread durable event 日志 | `1.3–1.6` 事件重放、去重与 Snapshot 检查点 |
| Relay `relaySequence` / ACK | 单 Workspace Relay 投递流 | Relay 帧排序、重投、ACK 与缺口检测 |

最后两行分属完全独立的序列空间：

- `RuntimeEventEnvelope.sequence` 仅在当前 `runtimeInstanceId` 内单调递增；`1.3–1.6` durable event
  则使用按 Thread 排序的不透明 `eventCursor`；
- Relay `relaySequence` 与 ACK 仅描述 Companion→Relay 安全投影流的投递进度，既不能用来确认
  Runtime `eventCursor`，也无法由 Runtime `sequence` / `cursor` 推导，且协议不设持久化的 Relay outbox。

`threadId`、`turnId`、`approvalId` 等属于业务领域对象 ID，不承担上述关联、幂等或流控游标职责。

Workspace 租约（lease）边界如下：

| lease | 获取/释放方式 |
|---|---|
| Browser client | 宿主在认证连接建立/断开时手动调用 `attachBrowser()` / `detachBrowser()` |
| 后台 Shell | 宿主手动调用 `acquireBackgroundShellLease()` 并保存返回的释放函数 |
| Turn | 仅在通过 `CompanionWorkspace.startTurn()` 发起时自动获取，收到终态事件后自动释放 |
| Interaction | Runtime `1.2–1.6` 的 Approval 与 User Input 以及 `"1.1"` Approval 兼容层均由 Broker 托管；返回结果、中止、超时或 Turn 终态共用单次结算路径 |
| Runtime 1.0 Approval fallback | 仅在受信 Wire `1.0` 旧版桥接器内由 `approval.required` 事件获取，并在响应或终态事件后释放；严禁用于 Cloud / Browser 场景 |

浏览器断线时不要调用 `thread.detach` 或直接关闭 Runtime。`outbound.stop()` 仅停止 Relay 重连、
桥接器与事件订阅，不会关闭 Runtime；Runtime 子进程的生命周期由 `workspace.closeIfIdle()` 独立管理。

自定义底层宿主仍可通过 `localApprovalPolicy` 进一步收窄审批权限；返回
`"require-local-confirmation"` 只会抛出 `LocalConfirmationRequiredError`，不会自动弹出本机确认框。
官方 P0 宿主固定返回 `"allow"`，允许已认证的 Web 端完成 Runtime 判定为 `confirm` 的交互。

Relay 帧缓冲、ACK、幂等缓存与租约均仅驻留在 Companion 进程内存中。Companion 重启后必须重新建立连接与租约；本地 Runtime 协商到 `1.3–1.6` 时可通过持久事件重放恢复，否则通过 `thread.snapshot` 收敛界面。切勿把 Relay 内存缓冲当作持久事件日志。

`authentication.request` 与文件选择器（File Picker）没有远程投影器，仅限本地使用；`1.3–1.6` 的持久事件恢复也不会扩大这一边界，未来若需开放远程支持，必须先完成专项安全设计评审。

敏感 Workspace 可向 `CompanionRelayBridgeV11` 注入 `RelayPayloadCipherV11`。一旦绑定 cipher：

- 明文 `runtime.request` 会在触达 Runtime 前被拒绝，固定返回 `RELAY_ENCRYPTION_REQUIRED` 且 `retryable: false`；
- 请求必须使用 `runtime.encrypted`，响应、事件与交互帧也仅以加密信封发送；
- Relay 仍可读取 Workspace ID、`payloadKind`、`requestId` 或 `relaySequence` 等路由元数据；
- 加密算法、AEAD、nonce 管理、密钥协商/轮换、浏览器端加解密实现与密钥存储均由宿主负责。

完整消息结构、缓存、租约与关闭语义见
[`@roll-agent/relay-protocol` Relay v1 参考](./companion-relay-v1-reference.md)。

## 云端运行 Roll

如果 Roll 直接部署在云端，它只能访问云端分配的 Workspace。多租户部署必须严格隔离：

```text
Tenant / Workspace → isolated Roll Worker → isolated filesystem/secrets
```

Next.js Web/API 层保持无状态；严禁让多个不可信租户共享同一个 Roll 进程、`ThreadStore`、
环境变量或 Shell。

## 验证清单

- 新版 Runtime 初始化返回 `"1.6"`，且 `start()` / `connect()` 在返回前完成 capability ACK；
- 动态注册或撤销 handler 会递增 `revision`；撤销能力会立即中止未决交互并屏蔽迟到返回值；
- 本地 UI 适配器可让旧版 Runtime 逐级回退至 `"1.1"`，或切换到独立的 `"1.0"` 适配器；Relay Wire `1.1–1.3` 宿主则必须拒绝 Runtime `"1.0"`；
- 会话的创建、列表、浏览、打开、重命名、删除与历史独立分页均正常工作；
- `1.2–1.6` 的 Approval / User Input 与 `"1.1"` Approval 仅由类型化 Server Request handler 结算，`approval.required` 保持只读；
- `runtime.serverRequest.cancel` 会中止本地 handler，`approval.resolved` 正确收敛审批视图；
- 发生上下文压缩后，分页遍历 Snapshot 仍能完整恢复新格式 Thread 的历史消息；
- Snapshot 不暴露 `raw`、原始 Tool `input` 或敏感凭据；
- `1.3–1.6` 事件恢复严格遵守“重放通知 → `runtime.events.resume` 响应屏障 → 释放暂存实时事件”的顺序，并按 `eventId` 去重；
- 游标过期/缺口、Runtime 重启与实时序列缺口均能自动回退至恢复快照，且不重放 ephemeral 事件；
- Runtime 异常退出时，尚未终止的 Turn 标记为 `outcome unknown`；
- UI 收到 `outcome unknown` 后清理运行态、保留已生成的部分输出，且不自动重放副作用请求；
- 收到非法帧或不符合 Schema 的响应 DTO 时立即关闭连接并拒绝挂起请求；
- Relay 重复投递同一请求不会启动第二个 Turn；
- 远程批准不会绕过本地审批策略，未授权工具的 `appOutput` 不会向远端泄露；
- Relay Wire `1.1–1.3` 宿主在本地 Runtime 仅协商到 `"1.0"` 时显式拒绝连接，绝不将旧版时间线事件当作可写交互；
- Wire `1.1–1.3` 的拉取查询（如 Snapshot、`operation.get`、`operation.result.get`）均经过显式投影器脱敏，遇到畸形结果时按 fail-closed 原则拒绝，且公开错误绝不泄露 Runtime 或本地策略的原始报错信息；
- 绑定 cipher 的 Workspace 拒绝明文请求，且仅发送加密信封；
- 浏览器断线后本地长耗时任务继续运行；
- Companion 重启后通过 Runtime `1.3–1.6` 持久事件恢复或 Snapshot 收敛，不依赖进程重启前的旧 Relay ACK、缓存或租约。

`roll chat` TUI 不经过上述 stdio Server Request 链路，仍沿用进程内既有的 `clack` 选择式工具确认交互。
