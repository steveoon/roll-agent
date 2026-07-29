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

let watchedTurnId;
let reportOutcomeUnknown = () => {};
const outcomeUnknown = new Promise((resolve) => {
  reportOutcomeUnknown = resolve;
});

const client = await RollNodeClient.start({
  cwd,
  onStderr: (line) => console.error(line),
  onTurnOutcomeUnknown: (turnId) => {
    if (turnId === watchedTurnId) {
      reportOutcomeUnknown({ kind: "outcome-unknown", turnId });
    }
  },
});

let releaseTerminalEvent = () => {};
let releaseRuntimeExit = () => {};

try {
  const { thread } = await client.request("thread.create", {
    requestId: randomUUID(),
    title: "Runtime UI quickstart",
  });

  const turnId = randomUUID();
  watchedTurnId = turnId;
  const terminal = new Promise((resolve, reject) => {
    releaseTerminalEvent = client.onEvent((envelope) => {
      console.log(JSON.stringify(envelope));
      if (envelope.threadId !== thread.id || envelope.turnId !== turnId) {
        return;
      }
      if (
        envelope.event.type === "turn.completed" ||
        envelope.event.type === "turn.cancelled" ||
        envelope.event.type === "turn.failed"
      ) {
        releaseTerminalEvent();
        releaseRuntimeExit();
        resolve({ kind: "terminal", type: envelope.event.type });
      }
    });
    releaseRuntimeExit = client.onExit(({ error }) => {
      releaseTerminalEvent();
      releaseRuntimeExit();
      reject(error);
    });
  });

  await client.request("turn.start", {
    requestId: randomUUID(),
    threadId: thread.id,
    turnId,
    input: { text: "用一句话介绍这个项目" },
  });

  const outcome = await Promise.race([terminal, outcomeUnknown]);
  if (outcome.kind === "outcome-unknown") {
    throw new Error(
      `Turn ${outcome.turnId} 的结果未知；不要自动重放，重启 Runtime 后读取 Snapshot`,
    );
  }
  console.error(`Turn ended with ${outcome.type}`);
} finally {
  releaseTerminalEvent();
  releaseRuntimeExit();
  await client.shutdown();
}
```

## 3. 运行

```bash
node smoke.mjs /absolute/path/to/workspace
```

预期结果：

1. stderr 显示 Roll 启动日志；
2. stdout 依次出现 `turn.started`、消息流和终止事件；
3. 只有与本次 `threadId + turnId` 匹配的终止事件才会结束等待；
4. Runtime 提前退出时脚本报告错误；已被 Runtime 接收但没有终态的 Turn 会报告
   `outcome unknown`，且不会自动重放；
5. 脚本最终等待 Runtime 子进程真实退出。

## 4. 验证恢复

保存 `thread.id`，重新连接后调用：

```js
// 继续对话前先恢复/附着 Session；只查看历史时可直接 snapshot。
await client.request("thread.open", { threadId });

const messages = [];
let messageBeforeSequence;

do {
  const snapshot = await client.request("thread.snapshot", {
    threadId,
    limit: 100,
    ...(messageBeforeSequence === undefined
      ? {}
      : { messageBeforeSequence }),
  });
  messages.unshift(...snapshot.messages.items);
  messageBeforeSequence =
    snapshot.messages.nextBeforeSequence ?? undefined;
} while (messageBeforeSequence !== undefined);

console.log(messages);
```

Snapshot 的持久数据源是追加式 transcript，不是可能已被模型上下文压缩的活动消息；单次响应
仍受分页限制。消息和 Operation 使用独立 cursor，分别遍历各自的 `nextBeforeSequence`
才能恢复可用的全部历史。`transcriptCompleteness: "legacy_snapshot"` 表示该 Thread 来自
旧格式，不能宣称其历史绝对完整。

下一步可参考
[`如何用自己的技术栈接入 Roll Agent`](./how-to-build-roll-runtime-ui.md) 接入审批、取消或
远程 Companion；精确 API 见
[`Runtime Protocol v1 参考`](./runtime-protocol-v1-reference.md) 和
[`Node 客户端参考`](./client-node-reference.md)。
