# 创建第一个 Roll Runtime UI 客户端

本教程演示如何用 Node.js 创建一个最小终端客户端：启动本地 Roll 进程、创建会话（Thread）、打印流式事件、注册适用于协议 `1.1–1.6` 的审批处理器（`approval.request` handler），并在单轮对话（Turn）结束后优雅退出。

本教程只覆盖本地 stdio Runtime Protocol：

```text
本地 UI → @roll-agent/client-node → roll runtime serve --stdio
```

它不安装或启动 `@roll-agent/companion`，也不启用 Cloud Relay 或远程 Web 访问。

## 前置条件

- Node.js `>=22.6.0`
- 已安装并配置 `roll`
- 一个包含 `roll.config.yaml` 或可使用默认配置的 Workspace

## 1. 安装客户端

```bash
pnpm add @roll-agent/client-node @roll-agent/protocol
```

## 2. 创建 `smoke.mjs`

```js
import { randomUUID } from "node:crypto";
import { RollNodeClient } from "@roll-agent/client-node";
import { getRuntimeProtocolCapabilities } from "@roll-agent/protocol";

const cwd = process.argv[2];
if (!cwd) throw new Error("Usage: node smoke.mjs /absolute/workspace");

let watchedTurnId;
let reportOutcomeUnknown = () => {};
const outcomeUnknown = new Promise((resolve) => {
  reportOutcomeUnknown = resolve;
});

const client = await RollNodeClient.start({
  cwd,
  serverRequestHandlers: {
    "approval.request": async (params, { signal }) => {
      signal.throwIfAborted();
      const { approval } = params;
      const interaction =
        "interactionId" in params ? ` interaction=${params.interactionId}` : "";
      console.error(
        `Quickstart 拒绝 Tool：${approval.agentName}/${approval.toolName}${interaction}`,
      );
      return {
        decision: "reject",
        reason: "Quickstart 未实现交互式确认 UI",
      };
    },
  },
  onStderr: (line) => console.error(line),
  onTurnOutcomeUnknown: (turnId) => {
    if (turnId === watchedTurnId) {
      reportOutcomeUnknown({ kind: "outcome-unknown", turnId });
    }
  },
});

const protocolVersion = client.getInitializationResult().protocolVersion;
console.error(`Negotiated Runtime Protocol ${protocolVersion}`);
if (!getRuntimeProtocolCapabilities(protocolVersion).serverRequests) {
  await client.shutdown();
  throw new Error(
    `This quickstart requires a Runtime Protocol version with Server Request support (1.1 or newer); it does not implement the v1.0 approval.respond path (negotiated ${protocolVersion})`,
  );
}

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
2. 最新版 Runtime 输出 `Negotiated Runtime Protocol 1.6`，且 `RollNodeClient.start()` 在返回前已完成客户端能力确认（capability ACK）；连接旧版 Runtime 时会自动逐级回退，若对端仅支持 `"1.0"`，脚本会主动关闭连接并报错退出；
3. stdout 依次出现 `turn.started`、消息流和终止事件；
4. 只有与本次 `threadId + turnId` 匹配的终止事件才会结束等待；
5. 若本轮触发 Tool Approval，`approval.request` handler 安全拒绝，不会默认批准；
6. Runtime 提前退出时脚本报告错误；已被 Runtime 接收但没有终态的 Turn 会报告
   `outcome unknown`，且不会自动重放；
7. 脚本最终等待 Runtime 子进程真实退出。

在正式 GUI 应用中，应将 handler 上下文中的 `signal` 传入本地审批弹窗。一旦收到 `runtime.serverRequest.cancel`（协议 `1.2–1.6` 按逻辑 `interactionId` 匹配，`1.1` 按当次投递的 `serverRequestId` 匹配）、客户端撤销对应能力、调用 `shutdown()` 或 Runtime 进程退出，`signal` 都会触发中止，此时应立即关闭弹窗并停止后续处理；即使 handler 延迟返回，客户端也不会再发回响应。在协议 `1.1–1.6` 中，`approval.required` 事件仅用于只读展示，最终状态由 `approval.resolved` 事件收敛。

协议 `1.2–1.6` 的逻辑 `interactionId`、handler 上下文中的 JSON-RPC `requestId`，以及写操作参数中的幂等键 `params.requestId` 分属三套独立标识，UI 切勿混用或互相转换。

若产品必须连接旧 Runtime，请实现一个明确分离的 `"1.0"` adapter：监听
`approval.required` 并调用 `approval.respond`。不要让同一个审批决定同时走两条写入路径。

## 4. 验证恢复

保存 `thread.id`，重连后先按协商出的协议版本恢复会话状态。在协议 `1.3–1.6` 下，必须先交由事件恢复管理器（`createEventRecovery()`）接管该 Thread，切勿先调用可能返回大体积历史记录的 `thread.open`：

```js
if (client.getInitializationResult().limits.eventReplay) {
  const recovery = client.createEventRecovery();
  await recovery.resumeThread({
    threadId,
    checkpoint: await loadCheckpoint(threadId),
    applySnapshot: async (snapshot, context) => {
      await replaceLocalThreadView(snapshot, context.reason);
    },
    onDurableEvent: async (event, checkpoint) => {
      await applyAndCheckpoint(event, checkpoint);
    },
    onEphemeralEvent: (event) => renderLiveDelta(event),
  });
} else {
  // 旧协议没有 durable replay；继续对话时显式恢复 Session。
  await client.request("thread.open", { threadId });
}

// 完整历史时间线需通过分页单独拉取，与 1.3–1.6 受字节上限约束的恢复投影分开读取。
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
才能恢复可用的全部历史。分页只限制记录条数，不会拆分一条超大的 legacy message，因此不能
把普通 Snapshot 分页当作字节上限保证。`transcriptCompleteness: "legacy_snapshot"` 表示该
Thread 来自旧格式，不能宣称其历史绝对完整。

在协议 `1.3–1.6` 中，恢复管理器会先暂存恢复期间并发到达的实时持久事件（durable event），以 `runtime.events.resume` 的响应作为“重放→实时”切换屏障（barrier），随后按 `cursor` 排序并按 `eventId` 去重后再统一交付；若遇到游标过期、日志缺口或 Runtime 重启，管理器会自动回退到受字节上限约束的恢复快照（recovery Snapshot）。事件重放不会重新触发审批、用户输入等控制请求或任何副作用。协议 `1.0–1.2` 不支持事件重放，仍直接读取普通 Snapshot。

此外，协议 `1.2–1.6` 的客户端还可通过 Snapshot 中的 `pendingInteractions` 恢复当前响应方尚未结算的安全交互视图（`1.0–1.1` 不包含该字段）。协议 `1.3–1.6` 的 Snapshot 额外提供可空的 `eventCursor` 作为事件恢复检查点，切勿将其与历史分页游标或远程 Relay ACK 混用。

下一步可参考
[`如何用自己的技术栈接入 Roll Agent`](./how-to-build-roll-runtime-ui.md) 接入审批、取消或
远程 Web；精确 API 见
[`Runtime Protocol v1 参考`](./runtime-protocol-v1-reference.md) 和
[`Node 客户端参考`](./client-node-reference.md)。
