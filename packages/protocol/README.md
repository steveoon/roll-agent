# `@roll-agent/protocol`

Roll Runtime Protocol v1 的 TypeScript Schema、类型与跨语言 JSON Schema。

这个包只定义公共领域契约，不启动 Runtime，也不提供 Transport。Node.js 宿主可配合
[`@roll-agent/client-node`](https://www.npmjs.com/package/@roll-agent/client-node) 使用；
其他技术栈可直接实现 JSON-RPC + NDJSON + stdio Transport。

## 安装

```bash
pnpm add @roll-agent/protocol
```

## TypeScript API

```ts
import {
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SERVER_REQUEST_METHODS,
  compareRuntimeEventCursors,
  getApprovalExplanation,
  parseRuntimeMethodParams,
  parseRuntimeServerRequestParamsForVersion,
  type RuntimeEventEnvelopeV13,
} from "@roll-agent/protocol";

const params = parseRuntimeMethodParams(RUNTIME_METHODS.threadSnapshot, {
  threadId: "00000000-0000-4000-8000-000000000001",
  limit: 100,
});

console.log(RUNTIME_PROTOCOL_VERSION, params);

declare const incoming: { readonly params: unknown };
const approval = parseRuntimeServerRequestParamsForVersion(
  "1.2",
  RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
  incoming.params,
);

declare const checkpoint: RuntimeEventEnvelopeV13;
function handleEvent(event: RuntimeEventEnvelopeV13): void {
  if (event.event.type === "approval.required") {
    console.log(getApprovalExplanation(event.event.approval));
  }
  console.log(event.event.type, approval.interactionId);
  if (event.durability === "durable" && checkpoint.durability === "durable") {
    console.log(compareRuntimeEventCursors(checkpoint.cursor, event.cursor));
  }
}
```

主要导出包括：

- 协议常量：`SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`RUNTIME_PROTOCOL_VERSION`、
  `RUNTIME_METHODS`、`RUNTIME_SERVER_REQUEST_METHODS`、
  `RUNTIME_PROTOCOL_CAPABILITIES`、`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION`、
  `RUNTIME_FEATURES`、`RUNTIME_ERROR_CODES`、`RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES`、
  `RUNTIME_V13_MIN_CLIENT_FRAME_BYTES`、`RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES`；
- 能力查询：`getRuntimeProtocolCapabilities()`、
  `getRuntimeProtocolRegistry()`、`isRuntimeMethodAvailable()`、
  `isRuntimeServerRequestMethodAvailable()`、`isRuntimeServerRequestMethodRequired()`、
  `isLatestRuntimeServerRequestMethod()`、`getApprovalExplanation()`；
- 全部 Zod Schema 与派生类型；
- `runtimeMethodSchemas`、`parseRuntimeMethodParams()`、
  `parseRuntimeMethodResult()`；
- `runtimeServerRequestSchemas`、`parseRuntimeServerRequestParams()`、
  `parseRuntimeServerRequestResult()`；
- 按协商版本解析与投影：`parseRuntimeMethodParamsForVersion()`、
  `parseRuntimeServerRequestParamsForVersion()`、
  `parseRuntimeServerRequestCancelParamsForVersion()`、
  `projectRuntimeServerRequestParams()`、`projectRuntimeServerRequestCancelParams()`、
  `compareRuntimeEventCursors()`、`runtimeEventCursorDistance()`；
- latest 与矩阵类型：`LatestRuntimeServerRequestInput/Params/Result<TMethod>`、
  `RuntimeServerRequestInput/Params/ResultForVersion<TVersion,TMethod>`、
  `RuntimeServerRequestInput/Params/ResultForSupportedVersions<TMethod>`；
- JSON-RPC 与 Runtime Event Envelope 类型。

## JSON Schema 与 fixtures

- `@roll-agent/protocol/schema` 与 `@roll-agent/protocol/schema/latest`：最新版本
  JSON Schema Draft 2020-12 根 Schema；
- `@roll-agent/protocol/schema/1.3`、`/1.2`、`/1.1`、`/1.0`：严格按协商版本隔离的 Schema；
- `@roll-agent/protocol/fixtures/v1.3/*`：Protocol 1.3 durable event/replay fixtures；
- `@roll-agent/protocol/fixtures/v1/*`：冻结的 1.1/1.0 跨语言有效/无效消息 fixtures。
- `@roll-agent/protocol/fixtures/v1.2/*`：Protocol 1.2 capability/interaction fixtures。

协议版本与 npm 包版本相互独立。`RUNTIME_PROTOCOL_VERSION` 表示这个包提供的最新 wire
schema，并不代表调用方已实现对应 Client 能力。当前支持顺序为
`["1.3", "1.2", "1.1", "1.0"]`。`initialize` 请求保持旧 strict 形状；协商到 `"1.2"`
或 `"1.3"` 后，
Client 必须用 `client.capabilities.set` 提交单调 `revision` 与当前 Handler methods，Runtime
返回 registry 交集后才进入 interaction-ready。未知的未来 method 名可安全发送但不会被接受。

广告 `"1.3"` 同时声明 Client 能接收至少 `17 MiB` 的单个 Runtime→Client NDJSON 帧：
durable record 的绝对上限为 `16 MiB`，额外 1 MiB 留给 envelope 与 JSON-RPC 元数据。本地
入站预算低于 17 MiB 的 Client 必须省略 `"1.3"`。这不会扩大 Client→Runtime 出站额度；
初始化后的出站上限仍取本地预算与 Runtime 返回的 `limits.maxFrameBytes` 的较小值。
官方 Node 恢复管理器的默认 replay 暂存窗口为 10,000 条 / 32 MiB。

`"1.3"` 把 Runtime Event 分为 `durability: "durable" | "ephemeral"`。durable Event
携带独立的 `RuntimeEventId` 与不透明 `RuntimeEventCursor`，只有事务提交成功后才可发布；
ephemeral Event 继续只使用进程内 `sequence`。`thread.snapshot.eventCursor` 在没有 durable
Event 时为 `null`；`runtime.events.resume({ threadId, afterCursor })` 允许从 `null` 或已有
cursor 恢复，并以 `{ throughCursor, replayedCount }` response 作为 replay 到 live 的 barrier。
其中 `null` 固定表示原始日志起点；如果该起点已被 retention 裁剪，Runtime 返回
`EVENT_CURSOR_EXPIRED`，不会静默返回不完整的保留后缀。
Snapshot fallback 在 1.3 使用
`thread.snapshot({ threadId, limit: 1, recovery: true })`。返回值必须携带
`recoveryProjection: true`，保留 Thread/checkpoint/active Turn 元数据，但故意清空 messages、
operations、pending Approvals 与 pending Interactions；完整 timeline 需另发普通 Snapshot 分页读取，
未决 Interaction 则以当前连接上的 Server Request 为权威。该投影保证可装入一帧，1.2/1.1/1.0
会 strict 拒绝 `recovery` 参数并剥离 `recoveryProjection`。
调用方必须通过官方 cursor 比较/距离 helper 排序，不能解析 `rte1:` 内部格式。旧版本投影会
剥离 `eventCursor`、`durability`、`eventId` 与 `cursor`；cursor 过期或出现 gap 时回退 Snapshot。

`"1.2"` 的 `approval.request` 与 `userInput.request` 使用独立的 UUID brand
`interactionId`，并携带 `threadId`、`turnId`、绝对 `expiresAt` 与首版固定的
`sensitivity: "normal"`。
`runtime.serverRequest.cancel` 也只投影 `{ interactionId, reason }`。JSON-RPC `id`、
`InteractionId` 与 mutation `RequestId` 是不同生命周期的类型，不能混用。

`userInput.request` 提供 `text | multiline | number | boolean | choice` 五类 control，表单
最多 16 项且不支持 secret/password 类型。Client 返回 `submitted` 或正常的 `cancelled`
结果后，Runtime 会结合原始表单再次校验必填项、值类型、choice option、未知/重复 ID 与
数量边界，并按 control 定义顺序规范化提交值。

`"1.1"` 的首个 Server Request 仍是 `approval.request`。Runtime 可用
`runtime.serverRequest.cancel.params.serverRequestId` 引用该请求的 JSON-RPC `id`，
终止尚未完成的交互，并用只读
`approval.resolved` Event 向所有观察端同步最终状态；`"1.0"` 继续使用
`approval.required` + `approval.respond`。

为避免已有宿主被 minor 版本打断，无 version 的 `approvalRequestParamsSchema`、
`runtimeServerRequestCancelParamsSchema`、`runtimeServerRequestSchemas` 与对应 parse helper
固定为 `"1.1"` compatibility façade。无 version 的 Runtime method type/parser 同样冻结在
`"1.1"`；新实现应始终使用 negotiated-version helper/registry，或使用 supported-version
派生类型处理多个已协商版本。`runtimeMethodSchemas` 则表示 latest registry，不能单独用来
判断旧版本 method availability。

1.2 的 `thread.open` / `thread.snapshot` 必须返回 `pendingInteractions`（允许空数组）。
Approval 安全投影严格只有 `method`、`interactionId`、`threadId`、`turnId`、`expiresAt`、
`sensitivity: "normal"` 与 `approvalId`；User Input 投影只包含相同 metadata 和安全表单
字段。JSON-RPC `id`、原始 payload/result、提交值与 secret 不会进入 Snapshot。1.1/1.0
会剥离整个字段。

1.2 的 `activeTurn.status` 额外允许 `waiting-for-user`；1.1/1.0 仍冻结为
`running | cancelling`，version projector 会把 `waiting-for-user` 映射为 `running`。

Shell 审批的模型说明位于 `approval.preview.explanation`。它是一个可选的、最多 100
字符的显示辅助字段；`getApprovalExplanation()` 会完成类型和长度校验。说明不会替代
原始命令，也不会影响 Policy。该字段刻意保留在既有 `preview` JSON 内，因此 Runtime
Protocol `"1.0"` / `"1.1"` 的 strict 顶层结构不变，旧 GUI 可以继续解析，新 GUI
则可将它单独显示为“AI 说明”。内置 Shell 命令仅在分类器明确判定为 `dangerous`
时才向用户展示风险 `reason`；仅因无法证明安全而复用 `destructiveHint` 的 `unknown`
命令不会显示“破坏性操作”。GUI 在 `reason` 缺失时应使用中性提示或直接省略。

## 文档

- [Runtime Protocol v1 参考](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-v1-reference.md)
- [架构与安全边界](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-architecture.md)
- [创建第一个 Runtime UI 客户端](https://github.com/steveoon/roll-agent/blob/main/docs/tutorial-runtime-ui-quickstart.md)
- [使用自己的技术栈接入 Roll](https://github.com/steveoon/roll-agent/blob/main/docs/how-to-build-roll-runtime-ui.md)
