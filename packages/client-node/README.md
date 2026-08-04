# `@roll-agent/client-node`

面向 Node.js、Electron 主进程和本地 Companion 的 Roll Runtime Protocol v1 客户端。
客户端优先协商 `"1.2"`，并在 `client.capabilities.set` ACK 完成后才结束连接；旧 Runtime
继续精确回落到 `"1.1"` / `"1.0"`。

它负责启动或连接 Runtime、初始化协商、JSON-RPC 请求、流式事件、协议校验、未知 Turn
结果跟踪，以及可等待的有界子进程关闭。Renderer 不应直接持有该客户端或子进程句柄。

本包只解决本地 Runtime 连接。它不包含 `@roll-agent/companion`、Cloud Relay 或远程访问
能力；Local-only Desktop 只需要本包。只有产品需要让远程 Web 访问用户本机 Runtime 时，
才在独立的本机 Host 层增加 `@roll-agent/companion`。

`RollNodeClient.start()` 默认执行 `roll runtime serve --stdio`。宿主必须确保 `roll` 命令
已安装，或通过 `command` 指向随应用分发的 Runtime；这仍然只建立本地 stdio 连接。

## 安装

```bash
pnpm add @roll-agent/client-node
```

## 最小示例

```ts
import { randomUUID } from "node:crypto";
import { RollNodeClient } from "@roll-agent/client-node";

const client = await RollNodeClient.start({
  cwd: "/absolute/path/to/workspace",
  serverRequestHandlers: {
    "approval.request": async ({ approval }, { signal }) => {
      signal.throwIfAborted();
      console.error(`Approval required: ${approval.toolName}`);
      return { decision: "reject", reason: "最小示例不自动批准 Tool" };
    },
  },
  onTurnOutcomeUnknown: (turnId) => {
    console.error(`Turn ${turnId} 的结果未知；不要自动重放`);
  },
});

try {
  const { thread } = await client.request("thread.create", {
    requestId: randomUUID(),
    title: "My UI",
  });
  await client.request("turn.start", {
    requestId: randomUUID(),
    threadId: thread.id,
    turnId: randomUUID(),
    input: { text: "检查这个项目" },
  });
} finally {
  await client.shutdown();
}
```

`turn.start` 只确认接收。应用必须持续消费 `onEvent()`，并把
`onTurnOutcomeUnknown()` 作为本地活动状态的收敛信号：停止 Working 状态、结束本地 waiter、
保留部分输出，随后在健康连接上或重连后读取 Snapshot。未知副作用不能自动重放。

初始化后的 `request()` 会按 negotiated version 校验参数与结果。返回类型由各版本 Schema
派生为 union；读取 1.2 Snapshot 的 `pendingInteractions` 前，可用
`"pendingInteractions" in snapshot` 缩窄。1.1 / 1.0 Snapshot 保持冻结形状。

## Runtime→Client Request

- `"1.2"` 没有强制 Handler，因此即使没有 Handler 也会广告 `["1.2","1.0"]`，并以
  revision 1 ACK 空能力集合；只有 `userInput.request` 时仍广告 `["1.2","1.0"]`，存在
  `approval.request` 时才同时广告要求该 Handler 的 1.1；
- `connect()` / `start()` 只有在 `"1.2"` 初始 capability ACK 后才 resolve，ACK 前不会把
  Runtime Server Request 投递给 Handler；
- `"1.1"` 的 `approval.request` handler 是唯一审批写入路径，
  `approval.required` 只是只读 View Event；
- Handler context 提供 `requestId` 和 `AbortSignal`。Runtime cancel、Client shutdown
  或连接退出都会 abort signal，并抑制迟到 Response；
- 用户拒绝必须返回正常 `{ decision: "reject" }`；Handler 缺失、抛错或返回非法结果会
  让 Runtime 以系统失败终止当前 Turn，不会伪装成 `user_rejected`；
- `approval.resolved` 用于关闭或更新审批 View；
- 已协商 `"1.2"` 后，新增或撤销 Handler 会串行发送递增 revision；同 method 的 Handler
  替换只在本地原子完成，不产生无意义 revision，旧 disposer 不会误删替代者；
- 撤销 `"1.2"` 能力会立即 abort 该 method 的未决 Interaction，并抑制迟到 Response；
  `runtime.serverRequest.cancel` 使用 `interactionId`，不会与 JSON-RPC request id 混用；
- `userInput.request` 可通过构造选项或实例方法 `onUserInputRequest()` 注册 typed named
  Handler。用户按 Esc 或关闭表单应返回正常 `{ status: "cancelled", reason? }`，不能 throw；
  完整提交值只返回给当前 Tool 调用，不会出现在 Runtime Event 或 Snapshot；
- 已协商 `"1.0"` 后不能通过 `registerServerRequestHandler()` 动态升级；应在
  `start()` / `connect()` 时传入初始 handler；
- 已协商 `"1.1"` 后仍可原子替换 handler；旧 handler 的 disposer 不会误删替代者。
  如果卸载当前版本的必需 handler，Client 会把连接视为协议能力失效并执行有界关闭，
  不会继续以 `"1.1"` 返回 `Method not found`。

未显式传入 `clientVersion` 时，初始化信息直接读取当前安装的
`@roll-agent/client-node` 包版本，不需要在源码与 `package.json` 之间手工同步。

当前 `stdio` Transport 不提供 Request replay/resume。断线后终止本地交互，并通过
Snapshot 收敛；不要重放旧 Approval、User Input 或 Turn。

## 文档

- [Node 客户端 API 参考](https://github.com/steveoon/roll-agent/blob/main/docs/client-node-reference.md)
- [Runtime Protocol v1 参考](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-v1-reference.md)
- [创建第一个 Runtime UI 客户端](https://github.com/steveoon/roll-agent/blob/main/docs/tutorial-runtime-ui-quickstart.md)
- [Electron 参考适配器](https://github.com/steveoon/roll-agent/tree/main/examples/electron-runtime-client)
