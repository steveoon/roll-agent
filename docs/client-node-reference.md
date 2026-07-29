# `@roll-agent/client-node` API 参考

## 运行环境

| 项目 | 值 |
|---|---|
| Node.js | `>=22.6.0` |
| 默认命令 | `roll runtime serve --stdio` |
| 协议 | Roll Runtime Protocol `"1.0"` |
| 默认请求超时 | `30,000 ms` |
| 默认本地帧上限 | `4 MiB` |
| 默认读取重试 | 最多 `1` 次，间隔 `100 ms` |
| 默认关闭阶段 | stdin `30s` → SIGTERM `10s` → SIGKILL `5s` |

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
| `clientVersion` | `string` | `"0.1.0"` | 初始化客户端版本 |
| `onStderr` | `(line) => void` | 无 | 逐行接收 Runtime 日志 |
| `onTurnOutcomeUnknown` | `(turnId) => void` | 无 | Turn 结果无法确认时调用 |
| `maxFrameBytes` | `number` | `4 MiB` | 本地入站与初始出站上限 |
| `requestTimeoutMs` | `number` | `30,000` | 单次请求超时 |
| `maxReadRetries` | `number` | `1` | 明确可重试读取的最大重试次数 |
| `readRetryDelayMs` | `number` | `100` | 读取重试间隔 |
| `shutdownOptions` | `RuntimeShutdownOptions` | 见关闭阶段 | 默认关闭预算 |

客户端构造成功后的 `initialize` 协商失败会进入有界关闭，不会把未完成初始化的子进程交给
调用方。

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
| `shutdown(options?)` | `Promise<RuntimeClientExit>` | 可等待且幂等的有界关闭 |
| `close()` | `void` | fire-and-forget 关闭；不向调用方暴露 shutdown rejection |

`onExit()` 的晚订阅者仍会在 microtask 中收到已经发生的退出结果。正常显式
`shutdown()` 也会触发 `onExit()`；不能仅凭 callback 被调用就显示为异常。

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
