# `@roll-agent/relay-protocol`

Browser-safe 的 Roll Companion Relay Wire 契约。

它不是 Cloud 服务、Browser SDK 或 Companion 进程；安装或导入本包不会建立连接、打开端口
或启动后台任务。

## 谁安装

| 使用方 | 是否直接安装 | 用途 |
|---|---:|---|
| 普通 Browser Web App | 否 | 安装 `@roll-agent/relay-client`，不直接处理 frame |
| 自定义 Browser Transport | 是 | 实现 Relay frame、ACK/gap 与恢复 |
| Cloud Relay Server | 是 | 校验、路由和持久化 Relay frame |
| Local Companion Host | 是 | 与 Cloud 使用同一 Wire 契约 |
| Local-only Desktop GUI | 否 | 直接使用 Runtime Protocol，不经过 Relay |
| Runtime / `roll chat` | 否 | 使用 `@roll-agent/protocol` 或进程内调用 |

```bash
pnpm add @roll-agent/relay-protocol
```

普通第三方 Web App 应安装 `@roll-agent/relay-client`；本包面向 Cloud Relay、Companion 和确实
需要自定义 Transport 的高级实现者。

## Control 1.0 与方向合同

Browser Session 的 HTTP 返回和 WebSocket 控制面从独立 subpath 导入，不属于
`relayMessageSchemaV11` 数据面 union：

```ts
import {
  RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION,
  RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION,
  parseRelayBrowserFirstControlFrame,
  relayBrowserControlMessageSchema,
  relaySessionDescriptorSchema,
} from "@roll-agent/relay-protocol/control";

const session = relaySessionDescriptorSchema.parse(await response.json());
const ready = parseRelayBrowserFirstControlFrame(firstWebSocketFrame);
relayBrowserControlMessageSchema.parse(laterControlFrame);
```

`session.ready` 必须是 Browser WebSocket 收到的第一帧，并固定声明 Control 1.0、Wire 1.1、
Relay 绑定的 Workspace 和在线状态。Browser 不能在请求中自行指定 `workspaceId`。
Ticket 无效、过期、重复消费或 Origin 不匹配时，Relay 必须在 HTTP upgrade 阶段拒绝连接；
这些错误属于 `RELAY_BROWSER_HANDSHAKE_ERROR_CODES`，不能伪装成已认证连接中的
`session.error`。后者只承载 `session.ready` 之后的会话错误。

方向 allowlist 固定为：Browser→Relay 只允许 Wire 1.1 `runtime.request` 与 `runtime.ack`；
Relay→Companion 同样只允许这两类。Relay→Browser 允许 Control 帧以及 response/event/gap/
Interaction 帧；Companion→Relay 还包含首帧 `device.connect`。`runtime.ack` 是 Wire 数据面，
不是 Control ACK。P0 不提供 E2EE，因此这些 P0 WSS allowlist 明确不含 `runtime.encrypted`。

## 版本

支持矩阵是 `["1.1", "1.0"]`。Wire 1.1 新增 typed Interaction；Wire 1.0 的 registry、
Schema、fixtures 和 Approval fallback 保持冻结。

为了让现有 Companion 和 Browser 不被 minor upgrade 静默升级，历史上没有版本后缀的
`RELAY_PROTOCOL_VERSION`、`relayMessageSchema`、`relayRequestMethodSchemas`、parser 和 type
仍固定指向 Wire 1.0。新代码应使用 `LATEST_RELAY_PROTOCOL_VERSION` 和显式的 `*V10` /
`*V11` / `*ForVersion` API。

```ts
import {
  LATEST_RELAY_PROTOCOL_VERSION,
  parseRelayMessageForVersion,
  relayMessageSchemaV11,
} from "@roll-agent/relay-protocol";

LATEST_RELAY_PROTOCOL_VERSION; // "1.1"
const frame = parseRelayMessageForVersion("1.1", input);
relayMessageSchemaV11.parse(frame);
```

`CompanionRelayBridge.connect(transport)` 这一历史一参入口仍只表示 Wire 1.0。支持 Wire 1.1
的 Host 必须使用显式协商版本的新入口；不得让旧调用自动选择 latest。

## Wire 1.1 Interaction

Wire 1.1 增加 `interaction.request`、`interaction.resolved`、
`interaction.cancelled` 三种 Companion→Browser frame。Browser 通过 mutation
`interaction.candidate` 提交候选；`approval.candidate` 只存在于冻结的 Wire 1.0。

远端候选不是独立授权事实源。Runtime policy 先决定 auto/confirm/deny；只有 confirm 才产生
可响应 Interaction，deny 不会被远端越过。官方 Companion 只再验证 request policy、Workspace、
responder 与绝对 deadline，不增加电脑端二次审批。低层自定义 Host 可以进一步收紧，但不能
放宽 Runtime 决议。

安全投影只允许：

- Approval：`approvalId`、`agentName`、`toolName`、可选 `explanation`；
- User Input：五类安全表单 control 及其 bounded 字段；
- resolved/cancelled：Interaction identity，不回显 Runtime Result 或原始取消原因；
- Timeline：安全消息、状态和 Tool 完成摘要；Tool input/output delta 与 Approval preview 会被剥离。

Runtime JSON-RPC `id`、原始 Tool input/output、secret、完整 User Input Result、本地授权信息
以及 Authentication/File Picker projector 都不能进入 Companion→Browser 投影。Browser→Companion 的
`interaction.candidate` 是 User Input Result 唯一允许的入站位置，并且必须关联原始表单重新校验。

Wire 1.1 Snapshot 不能重建一个仍可响应的 `interactionId`。Browser Session 重连时，Cloud
Relay 必须保留并重新投递尚未 resolved/cancelled 的 `interaction.request`；客户端不得从
`approvalId` 或 Snapshot 自行合成 Interaction identity。

Wire 1.1 的 pull 查询遵守同一边界：`thread.open` / `thread.snapshot` 必须把 Approval preview
投影为可选 explanation、移除本地 reason，并把 Operation display 与 outcome reason 脱敏；
Host 对前两种结果调用 `projectRelayThreadSnapshotV11(value)`，对 `operation.get` 调用
`projectRelayOperationGetResultV11(value)`。两个 projector 遇到畸形 Runtime 结果都会抛错并
fail closed。第一方 `CompanionRelayBridgeV11` 已自动应用它们；自定义 Host 仍必须在构造
`runtime.response` 前显式调用，不能把 Runtime 原始结果直接发送。

有意保留的内容包括完整 transcript 消息、Thread 标题/模型/时间元数据、安全 timeline 摘要，
以及 `thread.capabilities.manifest` 中可能出现的 cwd、平台、Agent、Skill、Tool Schema、规则
标识与 VCS 元数据。它们不是公开信息，Relay 与 Browser 宿主仍需按敏感数据保护。

冻结的 Wire 1.0 没有这些安全投影，只适用于处在等价本地信任边界内的 legacy peer。它不是
面向不受信 Cloud/Browser 的降级协议；需要远程投影的 Host 必须协商 1.1，失败时拒绝连接。

## Browser reference adapter

`@roll-agent/relay-protocol/reference-adapter` 提供最小、纯内存的 typed reference adapter：

```ts
import { createRelayBrowserReferenceAdapter } from
  "@roll-agent/relay-protocol/reference-adapter";

const adapter = createRelayBrowserReferenceAdapter({ protocolVersion: "1.1" });
const update = adapter.receive(frame);
const candidateRequest = adapter.createCandidate({
  workspaceId,
  interactionId,
  method: "approval.request",
  candidate: { decision: "reject", reason: "用户取消" },
});
```

Adapter 只做 Schema 校验、pending correlation 和 candidate frame 构造。它不提供账号身份、
controller 选举、可靠投递、WebSocket、持久 outbox 或 Interaction WAL；这些 responder
context 必须由宿主注入。

## Schema、fixtures 与 conformance

- `@roll-agent/relay-protocol/schema` 与 `/schema/v1.0`：冻结的 Wire 1.0 JSON Schema；
- `@roll-agent/relay-protocol/schema/v1.1`：Wire 1.1 JSON Schema；
- `@roll-agent/relay-protocol/control`：Control 1.0、Browser Session 和 WSS 方向 Schema；
- `@roll-agent/relay-protocol/control/schema`：Control 1.0 JSON Schema；
- `@roll-agent/relay-protocol/control/session-schema`：Browser Session JSON Schema；
- `@roll-agent/relay-protocol/control/fixtures/*`：Control/Session golden fixtures；
- `@roll-agent/relay-protocol/fixtures/v1/*`：字节冻结的 Wire 1.0 golden fixtures；
- `@roll-agent/relay-protocol/fixtures/v1.1/*`：Wire 1.1 Interaction 与安全负例；
- `@roll-agent/relay-protocol/conformance`：可复用的 N/N-1 suite。

历史 `runRelayProtocolConformance(adapter)` 一参调用固定执行 Wire 1.0 suite；新实现使用
`runRelayProtocolConformanceForVersion(version, adapter)` 显式选择 1.1 或 1.0。Suite 覆盖
版本协商、完整 method registry、duplicate/conflict、ACK/gap、Interaction 生命周期、加密
metadata 和安全 sentinel。

## 边界

本包不包含 Transport、WebSocket、账号/设备数据库、本地 Policy、加密实现或 Cloud 部署
代码。运行时代码只依赖 Browser-safe 的 `@roll-agent/protocol` 与 `zod`。Browser 与 Cloud
Relay 不能为了获得 Wire Schema 而安装 `@roll-agent/companion`。

Relay `requestId`、逻辑 `interactionId`、Runtime JSON-RPC `id`、Runtime mutation
`requestId` 与 Relay `relaySequence` 是不同的类型和生命周期，不能互相复用。
