# `@roll-agent/client-node`

面向 Node.js、Electron 主进程和本地 Companion 的 Roll Runtime Protocol v1 客户端。

它负责启动或连接 Runtime、初始化协商、JSON-RPC 请求、流式事件、协议校验、未知 Turn
结果跟踪，以及可等待的有界子进程关闭。Renderer 不应直接持有该客户端或子进程句柄。

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

## 文档

- [Node 客户端 API 参考](https://github.com/steveoon/roll-agent/blob/main/docs/client-node-reference.md)
- [Runtime Protocol v1 参考](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-v1-reference.md)
- [创建第一个 Runtime UI 客户端](https://github.com/steveoon/roll-agent/blob/main/docs/tutorial-runtime-ui-quickstart.md)
- [Electron 参考适配器](https://github.com/steveoon/roll-agent/tree/main/examples/electron-runtime-client)
