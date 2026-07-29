# 创建第一个 Roll Runtime UI 客户端

本教程用 Node.js 创建一个最小终端客户端。完成后，它会启动本地 Roll、创建 Thread、显示
流式事件，并在 Turn 完成后退出。

## 前置条件

- Node.js `>=22.6.0`
- 已安装并配置 `roll`
- 一个包含 `roll.config.yaml` 或可使用默认配置的 Workspace

## 1. 安装客户端

```bash
pnpm add @roll-agent/client-node
```

## 2. 创建 `smoke.mjs`

```js
import { randomUUID } from "node:crypto";
import { RollNodeClient } from "@roll-agent/client-node";

const cwd = process.argv[2];
if (!cwd) throw new Error("Usage: node smoke.mjs /absolute/workspace");

const client = await RollNodeClient.start({
  cwd,
  onStderr: (line) => console.error(line),
});

const terminal = new Promise((resolve) => {
  client.onEvent((envelope) => {
    console.log(JSON.stringify(envelope));
    if (
      envelope.event.type === "turn.completed" ||
      envelope.event.type === "turn.cancelled" ||
      envelope.event.type === "turn.failed"
    ) {
      resolve();
    }
  });
});

const { thread } = await client.request("thread.create", {
  requestId: randomUUID(),
  title: "Runtime UI quickstart",
});

await client.request("turn.start", {
  requestId: randomUUID(),
  threadId: thread.id,
  turnId: randomUUID(),
  input: { text: "用一句话介绍这个项目" },
});

await terminal;
await client.shutdown();
```

## 3. 运行

```bash
node smoke.mjs /absolute/path/to/workspace
```

预期结果：

1. stderr 显示 Roll 启动日志；
2. stdout 依次出现 `turn.started`、消息流和终止事件；
3. 脚本在终止事件后退出。

## 4. 验证恢复

保存 `thread.id`，重新连接后调用：

```js
const snapshot = await client.request("thread.snapshot", {
  threadId,
  limit: 100,
});
console.log(snapshot.messages.items);
```

即使 Roll 已对模型上下文做过压缩，Snapshot 仍从追加式 transcript 返回完整 UI 历史。

下一步可参考
[`如何用自己的技术栈接入 Roll Agent`](./how-to-build-roll-runtime-ui.md) 接入审批、取消或
远程 Companion。
