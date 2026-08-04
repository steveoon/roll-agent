# `@roll-agent/client-node` API 参考

## 运行环境

| 项目 | 值 |
|---|---|
| Node.js | `>=22.6.0` |
| 默认命令 | `roll runtime serve --stdio` |
| 最新协议 | Roll Runtime Protocol `"1.2"` |
| 无 Server Request handler 时 | 广告 `["1.2","1.0"]`；1.2 capability 集合为空 |
| 默认请求超时 | `30,000 ms` |
| 默认本地帧上限 | `4 MiB` |
| 默认读取重试 | 最多 `1` 次，间隔 `100 ms` |
| 默认关闭阶段 | stdin `30s` → SIGTERM `10s` → SIGKILL `5s` |

`@roll-agent/client-node` 只管理本地 Runtime Transport。它不会安装或启动
`@roll-agent/companion`，也不会让 Runtime 自动接入 Cloud Relay。需要远程 Web 访问时，
由用户本机另一个 Host 显式集成 Companion。

## 创建客户端

### `RollNodeClient.start(options)`

启动一个 Runtime 子进程并完成 `initialize`。

| option | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `cwd` | `string` | 必填 | 显式 Workspace；控制配置、Skills、Shell 与 Git 上下文 |
| `command` | `string` | `"roll"` | Runtime 命令 |
| `args` | `readonly string[]` | `["runtime","serve","--stdio"]` | 命令参数 |
| `env` | `NodeJS.ProcessEnv` | `process.env` | 子进程环境 |
| `clientName` | `string` | `"@roll-agent/client-node"` | 初始化客户端名 |
| `clientVersion` | `string` | 当前 `@roll-agent/client-node` 包版本 | 初始化客户端版本 |
| `onStderr` | `(line) => void` | 无 | 逐行接收 Runtime 日志 |
| `onTurnOutcomeUnknown` | `(turnId) => void` | 无 | Turn 结果无法确认时调用 |
| `maxFrameBytes` | `number` | `4 MiB` | 本地入站与初始出站上限 |
| `requestTimeoutMs` | `number` | `30,000` | 单次请求超时 |
| `maxReadRetries` | `number` | `1` | 明确可重试读取的最大重试次数 |
| `readRetryDelayMs` | `number` | `100` | 读取重试间隔 |
| `shutdownOptions` | `RuntimeShutdownOptions` | 见关闭阶段 | 默认关闭预算 |
| `serverRequestHandlers` | `RuntimeServerRequestHandlers` | 无 | Runtime→Client typed handler；1.2 通过 capability handshake 协商，1.1 仍要求覆盖必需方法 |

客户端构造成功后的 `initialize` 协商失败会进入有界关闭，不会把未完成初始化的子进程交给
调用方。

`start()` / `connect()` 会自动且仅发送一次 `initialize`。若协商到 `"1.2"`，
还会发送首个 `client.capabilities.set` 并等待 Runtime ACK；因此返回的 Client 已经可以
安全接收当前声明的 Server Request，ACK 前不会向调用方暴露连接。连接成功后再次通过
`request("initialize", ...)` 初始化会被客户端拒绝，既不会写入 Transport，也不会改变
已协商版本。

### `RollNodeClient.connect(options)`

在调用方提供的 `RuntimeClientTransport` 上完成初始化。Transport 必须提供：

```ts
interface RuntimeClientTransport {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  onExit(listener: (code, signal) => void): void;
  close(): void;
  terminate?(): void;
  forceClose?(): void;
}
```

`connect()` 同样接受 `serverRequestHandlers`、帧限制、请求 timeout、读取重试和关闭预算；
版本广告规则与 `start()` 完全相同。

只有实现 `terminate()` / `forceClose()` 的 Transport 才能执行完整的 SIGTERM / 强制关闭
阶段。

## 公共方法

| 方法 | 返回 | 说明 |
|---|---|---|
| `request(method, input)` | 方法对应 result | 校验 params/result 并发送 JSON-RPC 请求 |
| `onEvent(listener)` | 取消订阅函数 | 订阅已通过 Schema 校验的 Runtime 事件 |
| `onExit(listener)` | 取消订阅函数 | 订阅真实进程退出或最终有界终止失败 |
| `getInitializationResult()` | `InitializeResult` | 读取协商版本、实例 ID、features 与 limits |
| `getOutcomeUnknownTurnIds()` | `readonly TurnId[]` | 当前客户端生命周期内累计的未知 Turn |
| `registerServerRequestHandler(method, handler)` | 取消注册函数 | 注册或替换 typed handler；1.2 自动同步递增 capability revision |
| `shutdown(options?)` | `Promise<RuntimeClientExit>` | 可等待且幂等的有界关闭 |
| `close()` | `void` | fire-and-forget 关闭；不向调用方暴露 shutdown rejection |

`onExit()` 的晚订阅者仍会在 microtask 中收到已经发生的退出结果。正常显式
`shutdown()` 也会触发 `onExit()`；不能仅凭 callback 被调用就显示为异常。

## Runtime → Client Server Request

### 启动时注册

`approval.request` 是 1.2 与 1.1 当前共同支持的 Server Request：

```ts
const client = await RollNodeClient.start({
  cwd: "/absolute/path/to/workspace",
  serverRequestHandlers: {
    "approval.request": async (params, { requestId, signal }) => {
      const { approval } = params;
      const interactionId = "interactionId" in params ? params.interactionId : undefined;
      const decision = await showApprovalDialog({
        requestId,
        interactionId,
        approval,
        signal,
      });
      return decision === "approve"
        ? { decision: "approve" }
        : { decision: "reject", reason: "用户取消" };
    },
  },
});
```

公开类型：

```ts
interface RuntimeServerRequestContext {
  readonly requestId: JsonRpcId;
  readonly signal: AbortSignal;
}

type RuntimeServerRequestHandler<TMethod extends RuntimeServerRequestMethod> = (
  params: RuntimeServerRequestParamsForSupportedVersions<TMethod>,
  context: RuntimeServerRequestContext,
) =>
  | RuntimeServerRequestResultForSupportedVersions<TMethod>
  | Promise<RuntimeServerRequestResultForSupportedVersions<TMethod>>;
```

Handler 必须返回符合 `@roll-agent/protocol` Schema 的结果。用户拒绝是正常
`{ decision: "reject", reason? }` Result，不应通过 throw 表达；throw 会作为 Handler
失败返回 `-32603`，Runtime 随后 fail-closed 终止当前 Turn；它不会把系统失败记录成
`user_rejected`。

1.2 params 包含 `interactionId`、`threadId`、`turnId`、`expiresAt`、
`sensitivity` 和方法专属 payload；1.1 Approval params 继续保持
`{ threadId, approval, expiresAt? }`。分支代码应使用 `"interactionId" in params`
收窄，而不是把 JSON-RPC `requestId`、逻辑 `interactionId` 或 mutation
`params.requestId` 互相转换。

### 版本广告

| 构造时 handlers | Client 广告 | 可能协商结果 |
|---|---|---|
| 注册 `approval.request` | `["1.2","1.1","1.0"]` | 新 Runtime 为 `"1.2"`；1.1/1.0 Runtime 可逐级回退 |
| 无 handler / 空对象 | `["1.2","1.0"]` | 新 Runtime 为 `"1.2"` 且 ACK 空 capability；旧 Runtime 回退 `"1.0"` |

`"1.2"` 没有强制 handler；所有 Server Request 都由初始化后的
`client.capabilities.set` 协商。`"1.1"` 当前唯一必需 handler 是
`approval.request`。必需方法表由
`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION` 提供；未来协议版本新增必需方法时，
Client 必须覆盖该版本的全部方法才会广告它。可选 UI Request 应走独立的 Client
capability 协商，不能静默扩大既有版本的必需方法集合。调用方也可使用
`getRuntimeProtocolCapabilities()` 和 `isRuntimeServerRequestMethodRequired()` 查询同一
协议能力表。

`"1.1"` 是否被广告仍在 `start()` / `connect()` 初始化前决定。若已协商 `"1.0"`，再调用
`registerServerRequestHandler()` 会抛错；应把初始 handler 传给
`serverRequestHandlers`。

协商到 `"1.2"` 时，Client 在 `initialize` 后发送 revision `1`。后续新增或撤销
handler 都会串行发送更高 revision，并核验 Runtime 返回相同 revision 与预期交集。
capability 同步失败、revision 冲突或 ACK 集合异常会使连接 fail closed。

### `registerServerRequestHandler(method, handler)`

在已协商 `"1.2"` 或 `"1.1"` 的连接上注册或替换 handler，并返回取消注册函数：

```ts
const unregister = client.registerServerRequestHandler(
  "approval.request",
  async ({ approval }, { signal }) => {
    return await askUser(approval, signal);
  },
);

unregister();
```

取消注册不会降级当前连接的协议版本。在 1.2 中，Client 先立即撤销本地可处理资格并 abort
该 method 的全部未决交互，再发送更高 capability revision；迟到 Result 不会写回。
若该 handler 已经被后续注册替换，旧 disposer 是 no-op，不会误删新 handler。

在 1.1 中，若 disposer 要移除必需 handler，Client 会立即按协议违规 fail closed 并关闭
连接，避免继续宣称无法履行的能力。1.0 不支持连接建立后的 handler 注册。

### `AbortSignal` 与断线边界

以下情况会 abort 正在执行的 handler：

- Runtime 发送 `runtime.serverRequest.cancel`；
- 1.2 撤销该 method 的 capability；
- Client `shutdown()` / `close()`；
- Runtime 进程或 Transport 退出。

Handler 应把 `signal` 传给本地对话框、Promise 或其他可取消交互；abort 后关闭 UI 并停止
副作用。即使 Handler 忽略 signal 后迟到返回，Client 也不会再发送该 Request 的
Response。

`requestTimeoutMs` 只约束 Client→Runtime 的普通请求，不给人工审批添加 `30s` timeout。
1.2 cancel 使用逻辑 `interactionId`，1.1 cancel 使用当前投递的 JSON-RPC
`serverRequestId`；Client 都映射到同一个 handler `AbortSignal`。当前 `stdio` 连接
不支持持久 Server Request replay/resume：断线会 abort 全部 handler，重启后应读取
Snapshot 收敛，不能自动重放旧审批或旧 Turn。

在 `"1.2"` 与 `"1.1"` 中，`onEvent()` 收到的 `approval.required` 只是只读 View Event；审批结果
必须由 `approval.request` handler 返回。`approval.resolved` 用于关闭审批卡片、同步最终
状态。`"1.0"` 才继续使用 `approval.required` + `approval.respond`。

## 重试与幂等

客户端只会重试同时满足以下条件的请求：

1. 方法属于 `thread.list`、`thread.snapshot`、`thread.capabilities` 或 `operation.get`；
2. 服务端返回 `RollRpcError` 且 `data.retryable === true`；
3. 尚未达到 `maxReadRetries`。

`thread.open` 会附着/恢复 Session，不自动重试。Mutation 和 `turn.start` 等副作用请求也
不会自动重试。

## `outcome unknown`

以下情况可能把已经开始跟踪的 Turn 标记为未知：

- `turn.start` 请求超时或 Transport 写入结果不明确；
- 畸形 JSON、非法事件/result 或其他协议违规；
- 无法关联到请求的合法 `id: null` JSON-RPC error；
- Runtime/连接退出时仍有未终止 Turn。

可关联的 `RollRpcError` 表示请求已被明确拒绝；写入前发现超大出站帧也不会把 Turn 标记为
未知。

UI 收到未知结果后必须：

1. 停止本地 Working/Stop/streaming 状态并结束对应 waiter；
2. 保留用户消息与已经显示的部分回复；
3. 不自动重放副作用；
4. 如果连接仍健康则读取 Snapshot；如果连接已失败，则重连并确认新的
   `runtimeInstanceId` 后读取 Snapshot。

## 帧限制

- 入站 Runtime 帧超过本地 `maxFrameBytes`：`RollProtocolViolationError`，连接关闭；
- 初始化完成后的出站上限：
  `min(client.maxFrameBytes, initialize.limits.maxFrameBytes)`；
- 出站请求在写入前超过协商上限：
  `RollRequestFrameTooLargeError`，健康连接保持可用。

## 错误

| 错误类 | 关键字段 | 含义 |
|---|---|---|
| `RollRpcError` | `code`, `data?.rollCode`, `data?.retryable` | Runtime 返回的可关联 JSON-RPC error |
| `RollUncorrelatedRpcError` | 同上 | 合法 `id: null` error；连接状态不再可信 |
| `RollRuntimeExitedError` | `code`, `signal` | Runtime 在请求完成前退出 |
| `RollRequestTimeoutError` | `method`, `timeoutMs` | 请求超时 |
| `RollRequestFrameTooLargeError` | `frameBytes`, `maxFrameBytes` | 出站帧写入前超限 |
| `RollRuntimeClosingError` | 无 | 客户端已进入关闭阶段 |
| `RollRuntimeShutdownTimeoutError` | 三阶段 timeout | 有界关闭最终失败 |
| `RollProtocolViolationError` | `cause?` | 帧、事件、错误 data 或 result 不符合协议 |

## 相关文档

- [Runtime Protocol v1 参考](./runtime-protocol-v1-reference.md)
- [创建第一个 Runtime UI 客户端](./tutorial-runtime-ui-quickstart.md)
- [第三方 UI 接入指南](./how-to-build-roll-runtime-ui.md)
