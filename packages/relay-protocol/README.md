# `@roll-agent/relay-protocol`

Browser-safe 的 Roll Companion Relay Wire 契约。

它不是 Cloud 服务、Browser SDK 或 Companion 进程；安装或导入本包不会建立连接、打开端口
或启动后台任务。

## 谁安装

| 使用方 | 是否直接安装 | 用途 |
|---|---:|---|
| Browser Web App | 是 | 构造和校验 Relay frame |
| Cloud Relay Server | 是 | 校验、路由和持久化 Relay frame |
| Local Companion Host | 是 | 与 Cloud 使用同一 Wire 契约 |
| Local-only Desktop GUI | 否 | 直接使用 Runtime Protocol，不经过 Relay |
| Runtime / `roll chat` | 否 | 使用 `@roll-agent/protocol` 或进程内调用 |

```bash
pnpm add @roll-agent/relay-protocol
```

本包提供：

- 显式冻结的 Relay Wire version、message/method registry；
- `DeviceId`、`WorkspaceId`、Relay `requestId` / `envelopeId` Schema；
- `device.connect`、request/response/event/ack/gap/encrypted frame Schema；
- method-specific Params/Result parser；
- 以 `(workspaceId, requestId)` 为幂等键的 `new/replay/conflict` 分类；
- 稳定 Relay error code 与 retryability 映射；
- JSON Schema、跨语言 fixtures 和可复用 conformance cases。

```ts
import {
  RELAY_PROTOCOL_VERSION,
  relayMessageSchema,
  workspaceIdSchema,
} from "@roll-agent/relay-protocol";
import {
  runRelayProtocolConformance,
  runtimeRelayProtocolConformanceAdapter,
} from "@roll-agent/relay-protocol/conformance";
```

`@roll-agent/relay-protocol/schema` 导出 JSON Schema Draft 2020-12，
`@roll-agent/relay-protocol/fixtures/v1/*` 导出 golden fixtures。

`runRelayProtocolConformance()` 同时检查 frame、version 选择、完整 method registry 及其
`query` / `mutation` / `local-only` disposition、duplicate/conflict 与错误码形状、基于调用方
已证明连续投递前缀的 ACK 边界、gap recovery、加密 metadata 和 Relay error retryability。
Transport 必须自行保证发送失败后不会越过序号缺口；Companion Bridge 会终止失败的
transport generation 并在重连后重放。当前只有 `"1.0"`，因此只能验证同版本与未知版本
fail-closed；真实 `N/N-1` 矩阵必须等下一版 Relay Wire 存在后补齐，不能伪造历史版本。

## 边界

本包不包含 Transport、WebSocket、账号/设备数据库、本地 Policy、加密实现或 Cloud
部署代码。运行时代码只依赖 Browser-safe 的 `@roll-agent/protocol` 与 `zod`。

Browser 与 Cloud Relay 不能为了获得 Wire Schema 而安装 `@roll-agent/companion`。
TypeScript/JavaScript 实现直接使用本包；其他语言使用本包发布的 JSON Schema、fixtures
与 conformance cases。

当前只冻结 Relay Wire `"1.0"`。其中 `approval.candidate` 是现有 Approval 专属方法；
通用 typed interaction 与逻辑 `interactionId` 必须在后续 Relay Wire version 中定义，
不能静默扩张 `"1.0"`。

Relay version 冻结外层 envelope、message type 与 recognized method registry。
`local-only` 方法（当前为 `initialize`）只能由 Companion 在本地处理，不得转发给 Runtime；
`query` / `mutation` 才是远程请求分类。既有 Runtime method 的 Params/Result 继续属于按
Workspace 协商的 Runtime Protocol 契约；`relayRequestMethodSchemas` 是当前
`@roll-agent/protocol` 依赖版本的 typed 视图，不应被解释为 Relay `"1.0"` 单独复制的一套
Runtime Schema。
