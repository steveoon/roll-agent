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
  parseRuntimeMethodParams,
  parseRuntimeServerRequestResult,
  type RuntimeEventEnvelope,
} from "@roll-agent/protocol";

const params = parseRuntimeMethodParams(RUNTIME_METHODS.threadSnapshot, {
  threadId: "00000000-0000-4000-8000-000000000001",
  limit: 100,
});

console.log(RUNTIME_PROTOCOL_VERSION, params);

const approval = parseRuntimeServerRequestResult(
  RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
  { decision: "approve" },
);

function handleEvent(event: RuntimeEventEnvelope): void {
  console.log(event.event.type, approval.decision);
}
```

主要导出包括：

- 协议常量：`SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`RUNTIME_PROTOCOL_VERSION`、
  `RUNTIME_METHODS`、`RUNTIME_SERVER_REQUEST_METHODS`、
  `RUNTIME_PROTOCOL_CAPABILITIES`、`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION`、
  `RUNTIME_FEATURES`、`RUNTIME_ERROR_CODES`；
- 能力查询：`getRuntimeProtocolCapabilities()`、
  `isRuntimeServerRequestMethodRequired()`；
- 全部 Zod Schema 与派生类型；
- `runtimeMethodSchemas`、`parseRuntimeMethodParams()`、
  `parseRuntimeMethodResult()`；
- `runtimeServerRequestSchemas`、`parseRuntimeServerRequestParams()`、
  `parseRuntimeServerRequestResult()`；
- JSON-RPC 与 Runtime Event Envelope 类型。

## JSON Schema 与 fixtures

- `@roll-agent/protocol/schema`：JSON Schema Draft 2020-12 根 Schema；
- `@roll-agent/protocol/fixtures/v1/*`：跨语言有效/无效消息 fixtures。

协议版本与 npm 包版本相互独立。`RUNTIME_PROTOCOL_VERSION` 表示这个包提供的最新 wire
schema，并不代表调用方已实现对应 Client 能力。当前最新版本是 `"1.1"`；只有覆盖该版本
全部必需 Server Request handler 的 Client 才应广告它，否则应协商回退到 `"1.0"`。

`"1.1"` 首个 Server Request 是 `approval.request`。Runtime 可用
`runtime.serverRequest.cancel.params.serverRequestId` 引用该请求的 JSON-RPC `id`，
终止尚未完成的交互，并用只读
`approval.resolved` Event 向所有观察端同步最终状态；`"1.0"` 继续使用
`approval.required` + `approval.respond`。

## 文档

- [Runtime Protocol v1 参考](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-v1-reference.md)
- [架构与安全边界](https://github.com/steveoon/roll-agent/blob/main/docs/runtime-protocol-architecture.md)
- [创建第一个 Runtime UI 客户端](https://github.com/steveoon/roll-agent/blob/main/docs/tutorial-runtime-ui-quickstart.md)
- [使用自己的技术栈接入 Roll](https://github.com/steveoon/roll-agent/blob/main/docs/how-to-build-roll-runtime-ui.md)
