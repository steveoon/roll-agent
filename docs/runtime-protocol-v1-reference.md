# Roll Runtime Protocol v1 参考

## 版本与入口

| 项目 | 值 |
|---|---|
| 最新 Wire protocol | `"1.7"` |
| 兼容 Wire protocol | `"1.6"`、`"1.5"`、`"1.4"`、`"1.3"`、`"1.2"`、`"1.1"`、`"1.0"` |
| 正式命令 | `roll runtime serve --stdio` |
| 兼容命令 | `roll chat --server` |
| Event notification | `runtime.event` |
| Server Request cancel notification | `runtime.serverRequest.cancel` |
| 分帧 | NDJSON，一行一个 JSON-RPC 消息 |
| Runtime 默认接收入站帧上限 | `4 MiB`；通过初始化结果返回 |
| 1.3–1.7 Client 入站帧最低能力 | `17 MiB`；预算更低的 Client 不得广告 `"1.7"`、`"1.6"`、`"1.5"`、`"1.4"` 或 `"1.3"` |
| Event replay | `1.3–1.7` 只重放 durable event；`1.0–1.2` 不支持 |
| Attachments | `1.4–1.7` 提供 `attachment.stage` / `attachment.chunk` / `attachment.commit` / `attachment.release` 与 `turn.start.input.attachments`；仅当 `initialize` 结果 `features` 含 `"attachments"` 时可用 |
| App output | `1.5–1.7` 提供只读 `operation.result.get` 与 `OperationView` / `tool.completed` 的 `appOutput` 描述符；仅当 `features` 含 `"app-output"` 时可用 |
| Context recovery | `1.6–1.7` 在 Snapshot 保留可空 `contextRecovery` 并保留 durable `context.recovery.changed` 事件兼容 |
| Per-thread effort | `1.7` 在 `runtime.models.list` 与 `thread.model.get/set` 扩展每会话推理强度（effort）查询、能力公告与原子更新 |

Schema 单一数据源位于 `@roll-agent/protocol`。构建后可读取最新的
`@roll-agent/protocol/schema`（或等价别名 `@roll-agent/protocol/schema/latest`），也可按版本显式读取
`@roll-agent/protocol/schema/1.7`、`schema/1.6`、`schema/1.5`、`schema/1.4`、`schema/1.3`、`schema/1.2`、`schema/1.1`、
`schema/1.0` 的 JSON Schema Draft 2020-12 根 Schema；其 `$defs`
包含各方法 `params` / `result` / `request`、Server Request 以及 JSON-RPC response/event
定义，`x-roll-methods` 和 `x-roll-server-request-methods` 提供代码生成索引。
包同时导出子路径模块 `@roll-agent/protocol/app-output`（结构化应用输出契约校验、状态 Schema 与预算常量）与
`@roll-agent/protocol/observation-retention`（可替换观测保留元数据声明 Schema）。
跨语言一致性测试夹具位于 `@roll-agent/protocol/fixtures/v1.7/*`、`fixtures/v1.6/*`、`fixtures/v1.5/*`、`fixtures/v1.4/*`、
`fixtures/v1.3/*` 与 `fixtures/v1.2/*`；冻结的 `1.1/1.0` 夹具继续共用
`@roll-agent/protocol/fixtures/v1/*`。

TypeScript 宿主可直接从包根导入：

- `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`RUNTIME_PROTOCOL_VERSION`、
  `RUNTIME_METHODS`、`RUNTIME_SERVER_REQUEST_METHODS`、
  `RUNTIME_PROTOCOL_CAPABILITIES`、`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION`、
  `RUNTIME_ERROR_CODES`；
- `RUNTIME_PROTOCOL_REGISTRY`、`getRuntimeProtocolRegistry()`、
  `getRuntimeProtocolCapabilities()`、`isRuntimeMethodAvailable()`、
  `isRuntimeServerRequestMethodAvailable()`、`isRuntimeServerRequestMethodRequired()`、
  `isLatestRuntimeServerRequestMethod()`；
- 最新版 `runtimeMethodSchemas`、`parseLatestRuntimeMethodParams()`、`parseLatestRuntimeMethodResult()`，以及冻结为 `1.1` 兼容门面的
  `parseRuntimeMethodParams()`、`parseRuntimeMethodResult()`；
- `runtimeServerRequestSchemas`、`parseRuntimeServerRequestParams()`、
  `parseRuntimeServerRequestResult()`；
- `parseRuntimeMethodParamsForVersion()`、`parseRuntimeMethodResultForVersion()`、
  `parseRuntimeServerRequestParamsForVersion()`、
  `parseRuntimeServerRequestResultForVersion()` 与按版本解析的 cancel/error parser；
- `runtimeEventEnvelopeSchema`、`runtimeDurableEventEnvelopeV13Schema`、
  `runtimeEphemeralEventEnvelopeV13Schema`、`runtimeEventIdSchema`、
  `runtimeEventCursorSchema`、`compareRuntimeEventCursors()`、
  `runtimeEventCursorDistance()` 及各领域 Schema；
- `RuntimeMethodInput<TMethod>`、`RuntimeMethodParams<TMethod>`、
  `RuntimeMethodResult<TMethod>` 与 `LatestRuntimeMethodInput/Params/Result<TMethod>`；
- `RuntimeServerRequestInput<TMethod>`、`RuntimeServerRequestParams<TMethod>`、
  `RuntimeServerRequestResult<TMethod>`；
- `InteractionId`、`RuntimeEventId`、`RuntimeEventCursor`、
  `RuntimeMethodForVersion<TVersion>`、
  `RuntimeServerRequestInputForVersion<TVersion,TMethod>`、
  `RuntimeServerRequestParamsForVersion<TVersion,TMethod>`、
  `RuntimeServerRequestResultForVersion<TVersion,TMethod>`、
  `LatestRuntimeServerRequestInput/Params/Result<TMethod>`、
  `RuntimeServerRequestInput/Params/ResultForSupportedVersions<TMethod>`、
  `ThreadSnapshot`、`OperationResultView`、`ContextRecoveryView`、`RuntimeEventEnvelope` 等 DTO 类型。

不带 `ForVersion` 后缀的 `parseRuntimeMethod*`、Approval 参数/取消/错误辅助函数均为冻结的 `"1.1"` 兼容门面；而 `runtimeMethodSchemas`、`parseLatestRuntimeMethod*` 与 `LatestRuntimeServerRequest*` 则始终指向最新协议注册表。编写跨 `1.0–1.7` 多版本兼容的新代码时，应根据实际协商出的版本号调用 `*ForVersion` 系列函数，避免将高版本扩展字段意外写入旧版连接。

`@roll-agent/protocol` 只定义协议、Schema 和类型，不负责启动 Runtime 或管理连接。Node
进程生命周期由 [`@roll-agent/client-node`](./client-node-reference.md) 负责；远程
Web 接入使用由
[`@roll-agent/relay-protocol`](./companion-relay-v1-reference.md) 定义的独立 Relay v1
协议，并由用户本机 `@roll-agent/companion` Host 转接到 Runtime。

`RUNTIME_PROTOCOL_VERSION` 表示当前包提供的**最新 wire schema 版本**，适合 Server 默认值、
Schema 生成与 fixture 标注；它不表示任意调用方已经实现该版本要求的入站能力。直接使用
`@roll-agent/protocol` 的 Client 升级依赖后，必须审查新增的 Runtime→Client Request 与
Notification，并只在 `initialize.protocolVersions` 中广告自己确实实现的版本。
`RollNodeClient` 会按强制 handler 规则与帧预算生成版本列表，并在 `1.2–1.7` 初始化后自动完成
Client capability handshake。

协议 `1.3–1.7` 的单条 durable event 记录上限为 `16 MiB`；加上外层 Runtime 信封与
JSON-RPC 通知元数据后，客户端广告 `"1.7"`、`"1.6"`、`"1.5"`、`"1.4"` 或 `"1.3"` 即代表承诺能够接收至少 `17 MiB` 的单个
Runtime→Client NDJSON 帧。若本地入站帧预算低于 `17 MiB`，客户端必须同时省略 `"1.7"`、`"1.6"`、`"1.5"`、`"1.4"` 与 `"1.3"`。初始化结果中的
`limits.maxFrameBytes` 表示 Runtime 接收 Client 出站帧的上限；初始化完成后，Client 出站帧上限仍取本地预算与该返回值的较小者，不得将 `17 MiB` 入站要求视为同等的出站发送额度。

## 会话内模型选择与推理强度（1.6–1.7 可选扩展）

| 方法 | 参数 | 返回 |
|---|---|---|
| `runtime.models.list` | `{}` | `1.6` 返回 `{ configRevision, defaultModel, items }`；`1.7` 新增 `defaultEffort` 与每项 `effortCapability` |
| `thread.model.get` | `{ threadId }` | `1.6` 返回 `{ threadId, revision, configRevision, selection, status, active, reason? }`；`1.7` 新增 `effort`、`active.effort`、`active.effortCapability` 与 `target` |
| `thread.model.set` | `1.6`：`{ requestId, threadId, expectedRevision, configRevision, selection }`；`1.7`：`selection` 与 `effort` 至少提供一项 | 结构同对应版本的 `thread.model.get`；存在活动轮次时返回状态可能为 `pending` |

`selection` 取值为 `{ mode: "default" }` 或 `{ mode: "explicit", provider, model }`；`1.7` 的 `effort` 取值为 `{ mode: "default" }` 或 `{ mode: "explicit", level }`（`level` 为 `"off"` / `"low"` / `"medium"` / `"high"` / `"xhigh"` / `"max"`）。模型与推理强度共享同一个会话 `revision`：省略 `selection` 仅调整当前会话强度（保留“模型跟随默认”或既有显式模型、保留已初始化的压缩参数与请求预算）；省略 `effort` 则保留已有强度意图并在目标模型上原子校验（含继承默认值的实际解析档位及跨模型压缩兼容性）。非法组合在接纳前拒绝，不会消耗 `revision`，也不会替换已受理的 `pending` 状态。

`effortCapability` 按实际已确认的 Provider/模型系列正向公告四类能力：`{ kind: "levels", levels }`（无重复有序档位）、`{ kind: "toggle", offLevel, onLevel }`（互斥开关档位；读取到任何非 `offLevel` 的有效档位均视为开启，可用 `isThreadEffortToggleEnabled()` 判断）、`{ kind: "fixed" }` 或 `{ kind: "unknown" }`。`active.effort` 表示当前已生效档位，`target.effectiveEffort` 表示服务端解析后的目标生效档位（含 `mode: "default"`）。协商到 `"1.6"` 时，服务端出站严格剥离全部 `1.7` 字段，且 `@roll-agent/client-node` 会在本地直接拒绝携带 `effort` 的 `setThreadModel()` 请求。

会话级模型与推理强度覆盖仅驻留在当前 Runtime 进程内存中，执行 `thread.detach`、关闭连接或重启 Runtime 后即自动丢弃，不会写回配置文件或会话数据库，也不会引入新的数据库迁移。应用可在本地自行持久化偏好，并在重新打开会话后先拉取最新候选/能力与 `revision`，再显式调用 `thread.model.set` 恢复；CLI 不会自动继承该内存覆盖。

当模型只有一个有效档位时，Core 会在 `mode: "default"` 下采用该档位。例如，全局为 `medium` 时，切到 `gpt-5-pro` 的会话实际使用 `high`，再切回原模型会重新采用 `medium`。客户端也可以显式提交 `high` 来固定该会话的选择。其他显式档位和不兼容的显式压缩配置仍会在切换前被拒绝。

`revision` 是当前会话实例的不透明 UUID，每次变更模型/强度选择或重载配置后都会更新；`configRevision` 标识当前已加载的配置快照。若传入过期的 `expectedRevision`、不兼容的模型/强度组合、失效的 `configRevision` 或只读定时调度（scheduled）会话，服务端返回 `INVALID_PARAMS`（模型/强度选择错误通过 `details.modelSelection` 标明具体原因）；不支持模型选择的宿主返回 `CAPABILITY_UNAVAILABLE`。未实现 effort 能力的旧版 `1.6` `ThreadModelHost` 在 `initialize` 握手时自动降级协商至 `"1.6"`，避免凭空报告未实现的档位。`thread.model.get` 与 `thread.model.set` 均不会隐式打开会话，且遵循标准 `requestId` 幂等契约。

返回的 `status` 为 `applied`、`pending` 或 `failed`：

- `active` 在 `1.6` 为 `{ provider, model, reasoning, contextWindow? }`，在 `1.7` 额外包含 `effort` 与 `effortCapability`；尚未建立有效模型时可能为 `null`，而 `status: "applied"` 时 `active` 必为非空对象；
- `status: "failed"` 时附带固定错误原因 `reason`：`model-unavailable`、`prepare-failed`、`apply-failed`、`config-changed`、`settlement-failed`（`1.7` 另含 `effort-unsupported`，向 `1.6` 投影为 `config-changed`）；
- 若调用时当前会话存在进行中的 Turn，本轮全部模型请求（含工具返回后的续答与本会话 MCP Sampling）继续使用本轮开始时的模型与强度，待该轮终态结算完成后再自动应用 `pending` 选择；
- 执行默认配置重载（`runtime.modelConfig.reload`）时，Runtime 会保留并重新校验当前会话实例内的显式模型与强度选择。

这三个方法属于可选的 `1.6+` 宿主扩展，客户端不能仅凭协商到 `"1.6"` 或 `"1.7"` 就假定必定可用，需妥善处理 JSON-RPC `-32601`（Method not found）或 `CAPABILITY_UNAVAILABLE`。协议不为此下发额外的模型变更事件，客户端统一通过 `thread.model.get` 轮询或确认生效结果。切换模型或开关档位后的推理展示模式以 `active.reasoning` 为准；若切换到支持推理文本的状态且需在本地展示，仍须显式调用 `reasoning.text.subscribe`。

## 初始化

客户端必须首先且仅调用一次 `initialize`：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersions": ["1.7", "1.6", "1.5", "1.4", "1.3", "1.2", "1.1", "1.0"],
    "client": { "name": "my-gui", "version": "1.0.0" }
  }
}
```

结果包含协商版本、`runtimeInstanceId`、Server 信息、能力和限制。`limits` 会返回
`maxFrameBytes`、`maxPageSize`、`eventReplay` 和 `idempotencyCacheEntries`，`1.4–1.6` 还返回
`maxAttachmentBytes`、`maxAttachmentChunkBytes`、`maxTurnAttachments` 与 `maxStagedAttachments`；
客户端发送前必须遵守协商后的单帧上限。当前 Runtime 默认返回：

| limit | 当前默认值 | 语义 |
|---|---:|---|
| `maxFrameBytes` | `4 * 1024 * 1024` | Server 接受的单个 NDJSON 帧上限 |
| `maxPageSize` | `500` | 分页请求允许的最大 `limit` |
| `eventReplay` | `1.3–1.6` 为 `true`；旧版本为 `false` | 是否提供 durable event 持久重放 |
| `idempotencyCacheEntries` | `10,000` | 已完成 mutation 的进程内缓存窗口 |
| `maxAttachmentBytes` | `16 * 1024 * 1024` | `1.4+`：单个附件原始字节上限 |
| `maxAttachmentChunkBytes` | `2 * 1024 * 1024` | `1.4+`：`attachment.chunk` 单片原始字节上限 |
| `maxTurnAttachments` | `8` | `1.4+`：单个 `turn.start` 可引用的附件数 |
| `maxStagedAttachments` | `16` | `1.4+`：同一 Runtime 实例内同时保留的附件数，staged 与已 `commit` 未 `release`、未过 TTL 的都计入 |

这些值是协商结果，不应在客户端写死。旧 `session.*` RPC 在兼容期内不要求 v1 初始化。

Runtime 按客户端 `protocolVersions` 的顺序选择第一个双方支持的版本：

| Client 能力 | 广告版本 | 新 Runtime 协商结果 | Approval 控制路径 |
|---|---|---|---|
| 已注册 `approval.request` handler | `["1.7", "1.6", "1.5", "1.4", "1.3", "1.2", "1.1", "1.0"]` | `"1.7"` | capability ACK 后的 Server Request |
| 未注册 Server Request handler | `["1.7", "1.6", "1.5", "1.4", "1.3", "1.2", "1.0"]` | `"1.7"` | ACK 空集合；Runtime 不投递 Approval |
| N-1 Client | `["1.1", "1.0"]` | `"1.1"` | Server Request |
| 旧 Client | `["1.0"]` | `"1.0"` | Event + `approval.respond` |
| 无共同版本 | 例如 `["2.0"]` | `PROTOCOL_VERSION_UNSUPPORTED` | 不建立协议会话 |

版本能力表由 `RUNTIME_PROTOCOL_CAPABILITIES` 提供：

| 字段 | `"1.7"` | `"1.6"` | `"1.5"` | `"1.4"` | `"1.3"` | `"1.2"` | `"1.1"` | `"1.0"` |
|---|---|---|---|---|---|---|---|---|
| `serverRequests` | `true` | `true` | `true` | `true` | `true` | `true` | `true` | `false` |
| `serverRequestCapabilityNegotiation` | `true` | `true` | `true` | `true` | `true` | `true` | `false` | `false` |
| `approvalResolvedEvents` | `true` | `true` | `true` | `true` | `true` | `true` | `true` | `false` |
| `clientApprovalResponses` | `false` | `false` | `false` | `false` | `false` | `false` | `false` | `true` |
| `requiredServerRequestMethods` | `[]` | `[]` | `[]` | `[]` | `[]` | `[]` | `["approval.request"]` | `[]` |

新 Client 向旧 Runtime 发送 `["1.7", "1.6", "1.5", "1.4", "1.3", "1.2", "1.1", "1.0"]` 时，旧 Runtime 可按自身支持的最高版本选择 `"1.6"`、`"1.5"`、`"1.4"`、`"1.3"`、`"1.2"`、
`"1.1"` 或 `"1.0"`；严格的 `initialize` 入参未添加额外的 capability 字段。协商结果绑定当前连接，`1.0/1.1` 连接不能动态开启 `1.2–1.7` 的能力握手。`@roll-agent/client-node` 始终可广告无前置强制 handler 的 `"1.2"`；当本地入站帧预算不少于 `17 MiB` 时，还会一并广告 `"1.7"`、`"1.6"`、`"1.5"`、`"1.4"` 与 `"1.3"`；仅当注册了 `approval.request` 时才同时广告要求该 handler 的 `"1.1"`。
同一连接重复调用 `initialize` 会返回 `CAPABILITY_UNAVAILABLE`，且不会改变已经固定的协议版本与控制路径。

`REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION` 只描述某个 wire 版本的**必需**
Client handler，是从上述能力表派生的兼容导出。`1.2–1.6` 注册表包含可选的
`approval.request` 与 `userInput.request`；未来新增的方法也必须通过 `1.2+` capability 集合显式启用，不能静默追加到 `"1.1"` 的必需方法中。

### 1.2–1.6 Client capability handshake

协商到 `1.2–1.6`（`"1.6"`、`"1.5"`、`"1.4"`、`"1.3"` 或 `"1.2"`）后，Client 必须先调用：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "client.capabilities.set",
  "params": {
    "revision": 1,
    "serverRequestMethods": ["approval.request", "userInput.request"]
  }
}
```

`revision` 是从 1 开始的严格递增整数；method 最多 64 项、单项 1..100 字符且不可重复。
Client 可以发送未来未知 method，Runtime 返回按自身 registry 顺序排列的交集：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "revision": 1,
    "acceptedServerRequestMethods": ["approval.request", "userInput.request"]
  }
}
```

Client 必须按集合语义处理 `acceptedServerRequestMethods`：它是请求集的子集，顺序以
Runtime registry 为准，可以为空；只有出现未请求的 method 才构成协议违例。被 Runtime
丢弃的 method 不进入已协商集合，其 Server Request 到达 Client 时应答 `-32601`。

同 revision、同 method 集合是幂等重试；旧 revision，或同 revision 配不同集合，返回
`CAPABILITY_REVISION_CONFLICT`。ACK 前 Runtime 不得投递 Interaction；ACK 响应帧先于
其后任何新 Interaction 的投递帧写出。
`RollNodeClient.connect()` / `start()` 会等待首个 ACK 后才返回；动态注册或撤销
handler 会串行发送更高 revision。撤销 method 会终止该 method 的未决 Interaction，
迟到 Result 不能结算。

第一次调用 Runtime Protocol 方法或 legacy `session.*` 方法后，连接会锁定对应协议家族。
同一连接不能混用两套方法；例如完成 `initialize` 后调用 `session.approve` 会返回
`CAPABILITY_UNAVAILABLE`。这个边界防止 `1.1–1.6` Approval 绕过 Server Request 控制路径。

## ID 类型

| 字段 | Wire 类型 | 约束 |
|---|---|---|
| JSON-RPC `id` | `string` 或 `number` | 请求/响应关联；错误响应还可能为 `null` |
| `interactionId` | `string` | `1.2–1.6` 逻辑 Interaction UUID；显式重投时保持稳定 |
| `eventId` | `string` | `1.3–1.6` durable event UUID；只用于事件去重 |
| `cursor` / Snapshot `eventCursor` | `string` | `1.3–1.6` 不透明 `rte1:<eventLogId>:<threadSequence>:<eventId>`；不得拆解生成 |
| cancel `serverRequestId` | `string` 或 `number` | 仅 `1.1`；被取消投递的 JSON-RPC `id` |
| `threadId`, `turnId`, `approvalId`, `attachmentId` | `string` | UUID |
| `runtimeInstanceId`, `requestId` | `string` | UUID |
| `streamId`, `operationId` | `string` | UUID |
| `toolCallId`, `reasoningId` | `string` | 非空字符串，不保证 UUID |
| `thread.list.cursor` / `thread.browse.cursor` | `string` | 十进制数字字符串 |
| Snapshot `*BeforeSequence` | `number` | 非负整数 |

Interaction 链路必须分开以下身份：

- JSON-RPC `id` 只标识当前连接上的一次 Server Request 投递；
- `1.2–1.6` `interactionId` 标识逻辑交互，显式重投会换 JSON-RPC `id` 但保持它；
- `1.1` cancel `serverRequestId` 原样引用 JSON-RPC `id`；
- `approvalId` 是 Approval 领域对象 ID，可出现在 Snapshot 与 View Event 中；
- mutation `requestId` 只用于 Client → Runtime 写操作幂等，不参与 Server Request 响应。

当前 stdio 协议断线即取消，不定义持久或跨进程 Request 恢复。当前进程内的显式重投复用
`interactionId` 与原始 deadline，不复用 JSON-RPC `id`，也不延长 deadline。

## 方法

| 方法 | 分类 | 关键输入 | 输出 |
|---|---|---|---|
| `initialize` | 握手 | 版本列表、客户端信息 | 版本、实例、features、limits |
| `client.capabilities.set` | `1.2–1.6` 握手扩展 | `revision`, `serverRequestMethods` | `revision` 与 Runtime registry 交集 |
| `thread.list` | 只读 | `cursor?`, `limit?` | Thread 分页 |
| `thread.browse` | `1.6` 可选只读 | `workspace?`, `cursor?`, `limit?` | Thread 分页及项目归属、安全占用状态 |
| `thread.create` | mutation | `requestId`, `title?` | `ThreadSummary` |
| `thread.open` | 附着/恢复 | `threadId` | `ThreadSnapshot` |
| `thread.snapshot` | 只读 | 两个独立 before sequence、`limit?`、`1.3+` `recovery?` | `ThreadSnapshot` |
| `runtime.events.resume` | `1.3–1.6` 恢复 | `threadId`, `afterCursor` | replay barrier `{ throughCursor, replayedCount }` |
| `thread.rename` | mutation | `requestId`, `threadId`, `title` | 更新后的 Thread |
| `thread.delete` | mutation | `requestId`, `threadId` | `{ deleted: true }` |
| `thread.detach` | mutation | `requestId`, `threadId` | `{ detached: boolean }` |
| `thread.capabilities` | 只读 | `threadId` | 安全 Capability manifest |
| `runtime.modelConfig.get` | `1.6+` 可选只读 | `{}` | 模型配置应用状态 |
| `runtime.modelConfig.reload` | `1.6+` 可选 mutation | `requestId` | 模型配置应用状态 |
| `runtime.models.list` | `1.6+` 可选只读 | `{}` | 已配置模型候选目录（`1.7` 新增 `defaultEffort` 与 `items[].effortCapability`） |
| `thread.model.get` | `1.6+` 可选只读 | `threadId` | 已打开会话的内存模型/强度选择与 `active`（`1.7` 含 `effort` / `target`） |
| `thread.model.set` | `1.6+` 可选 mutation | `requestId`, `threadId`, `expectedRevision`, `configRevision`, `selection`（`1.7`：`selection` 与 `effort` 至少其一） | 更新后的会话模型/强度状态 |
| `reasoning.text.subscribe` | `1.6+` 可选连接级订阅 | `{}` | `{ subscribed: boolean }` |
| `turn.start` | mutation | `requestId`, `threadId`, `turnId`, 文本输入；`1.4+` 可加 `attachments` | 立即返回 `{ accepted: true, turnId }` |
| `turn.cancel` | mutation | `requestId`, `threadId`, `turnId` | `{ cancelling: boolean }` |
| `approval.respond` | `"1.0"` mutation | `requestId`, IDs, decision | `{ resolved: true }` |
| `approval.preview` | `1.6+` 可选只读 | `threadId`, `turnId`, `approvalId`, `offset?`, `maxChars?` | 分页脱敏变更快照 `{ text, totalChars, nextOffset }` |
| `operation.get` | 只读 | `threadId`, `operationId` | 脱敏 `OperationView`（`1.5+` 含 `appOutput` 描述符）或 `null` |
| `operation.result.get` | `1.5+` 只读 | `threadId`, `operationId` | `{ result: OperationResultView | null }` |
| `attachment.stage` | `1.4+` mutation | `requestId`, `threadId`, `fileName`, `mediaType`, `bytes`, `sha256`, `source`, `sourcePath?` | `{ attachmentId, state, descriptor? }` |
| `attachment.chunk` | `1.4+` mutation | `requestId`, `threadId`, `attachmentId`, `sequence`, `dataBase64` | `{ receivedBytes, nextSequence }` |
| `attachment.commit` | `1.4+` mutation | `requestId`, `threadId`, `attachmentId` | `{ descriptor }` |
| `attachment.release` | `1.4+` mutation | `requestId`, `threadId`, `attachmentId` | `{ released }` |

`thread.open` 会恢复并附着活动 Session，因此不是纯读取；它没有 `requestId`，不进入
mutation 幂等缓存，也不应被客户端自动重试。`turn.start` 的输入在 `1.3` 及更早版本仅支持
`{ "text": "用户消息" }`；`1.4–1.6` 额外接受 `attachments`（1..8 个已 `commit` 的 `attachmentId`），
引用附件时 `text` 可为空：

```json
{ "text": "", "attachments": ["00000000-0000-4000-8000-0000000000a1"] }
```

## 项目会话浏览

`thread.browse` 是可选的 Protocol `1.6` 扩展；旧宿主可能返回 `-32601`（Method not found），初始化 `features`
与 `thread.list` 的已有响应格式保持不变。`workspace` 省略表示全部项目，`null` 只选未分类会话，
字符串精确匹配宿主已规范化的工作区身份；`limit` 为 1..500，默认 100，`cursor` 是十进制分页位置。

每项返回 `{ thread: ThreadSummary, workspace: string | null, occupancy }`，其中工作区身份最多
4096 字符。`occupancy.status` 为 `available`、`occupied` 或 `unknown`，可选的 `owner` 只含
`kind`、`label` 和 `workspace`，不暴露 PID、进程身份令牌或凭证。浏览不获取占用、不迁移旧库、
不清理死亡进程记录。探活失败或占用账本不可读时返回 `unknown`。状态仅作展示，客户端在用户选择
恢复后仍须通过 `thread.open` 原子获取占用；读取历史快照使用 `thread.snapshot`。

## 模型配置应用

绑定了配置文件的 `roll runtime serve --stdio` 支持原地更新模型。协商 `1.6` 后先调用
`runtime.modelConfig.get` 探测。旧服务可能返回 `-32601`，未绑定配置文件的宿主返回
`CAPABILITY_UNAVAILABLE`。现有初始化字段保持兼容。

设置保存到磁盘后，客户端用新 `requestId` 调用 `runtime.modelConfig.reload`。Runtime 只重读启动时
绑定的配置来源，支持 `llm`、`runtime.provider`、`runtime.model`、`runtime.thinkingLevel` 的更新。
客户端应按配置来源定位受影响的 Runtime。如果新增项目配置导致有效来源切换，应走宿主的安全重连流程。
响应含 `status`、`revision` 和 `active: { revision, provider, model, reasoning }`。版本从零开始，在当前
`runtimeInstanceId` 内递增。客户端可用只读方法查询最新状态，重放同一个 `requestId` 会得到原响应。

- `applied` 表示已切换。模型初始化不发送推理请求。
- `pending` 表示当前 Engine 还有活动轮次，包括等待审批或用户输入。轮次继续使用原模型，全部结束后
  Runtime 重读最新配置并切换。客户端可在终止事件后查询，若仍待应用可短间隔重试查询。
- `failed` 附固定原因 `invalid-config`、`restart-required` 或 `apply-failed`。
  `active` 表示最近一次确认应用的模型。更改历史库或其他启动设置需要重新连接。

待应用或应用失败时，新 `turn.start` 会被拒绝，并返回 `CAPABILITY_UNAVAILABLE` 和
`details.modelConfigStatus`。此时客户端保留输入，确认状态为 `applied` 后用新的请求 ID 重试。
已有轮次、会话占用、历史、附件和后台资源继续沿用当前 Runtime。应用请求无需传配置路径、模型选项或凭证。

`active.reasoning` 为当前模型的 `summary`、`text` 或 `null`。初始化的 `features` 描述握手时模型的能力。
应用新模型后，客户端按查询结果刷新显示。需要展示本地 reasoning text 时，仍须显式调用
`reasoning.text.subscribe`，关闭 thinking 的模型拒绝该订阅。已授予同一连接的订阅沿用原有生命周期。

## Snapshot

`thread.snapshot` 返回：

```text
ThreadSummary
messages.items[]            UiMessage（1.4–1.6 parts 可含安全 attachment 元数据）
messages.nextBeforeSequence
operations.items[]          OperationView（1.5–1.6 含 appOutput 描述符）
operations.nextBeforeSequence
activeTurn?
pendingApprovals[]
pendingInteractions[]        1.2–1.6；必需字段，可为空
eventCursor                  1.3–1.6；必需字段，可为 null
contextRecovery              1.6；必需字段（含完整与恢复投影），无恢复记录时为 null
transcriptCompleteness      complete | legacy_snapshot
```

各版本投影规则如下：

- `contextRecovery` 存在于 `"1.6"`（含完整 Snapshot 与 `recoveryProjection: true` 恢复投影），`1.5` 及更早版本会自动剥离该字段；
- `operations.items[].appOutput` 描述符存在于 `1.5–1.6` 的完整 Snapshot 中（绝不内联完整结构化 `data`），`1.4` 及更早版本会自动剥离该描述符；
- `messages.items[].parts` 在 `1.4–1.6` 中可包含安全的 `attachment` 元数据片段（含 `mediaType`、`bytes`、`displayName?`，不含二进制内容与客户端本地路径）；向 `1.3` 及更早版本投影时会自动过滤非 `text` 片段，纯附件消息将变为 `parts: []`；
- `eventCursor` 存在于 `1.3–1.6`，`1.0–1.2` adapter 会剥离 `eventCursor` 与所有 `1.3+` 事件信封字段；
- `pendingInteractions` 存在于 `1.2–1.6`，`1.0–1.1` 的 `thread.open` 与 `thread.snapshot` 会完全剥离该字段。

`1.2–1.6` 的 `activeTurn.status` 为 `running | cancelling | waiting-for-user`；冻结的 `1.1/1.0`
形状只接受 `running | cancelling`。向旧 wire 投影时，`waiting-for-user` 会兼容映射为
`running`，而不是把未知枚举值泄漏给旧 Client。

`pendingInteractions` 是当前 responder 已 ACK、且对该 Thread 仍未结算的 Interaction 安全
投影。Approval 项严格只有：

```text
method = approval.request
interactionId
threadId
turnId
expiresAt
sensitivity = normal
approvalId
```

JSON-RPC `id`、Approval `preview`、原始 payload/result 与 secret 不会进入该投影。
User Input 项包含相同 Interaction metadata 与安全表单字段（`title`、`description`、`controls`、
choice `options`），但不包含完整 Result 或任何提交值。`1.2–1.6` Interaction 若缺少 Runtime 提供的
绝对 `expiresAt`，则 fail-closed，不会临时伪造 deadline。

消息与 Operation 使用独立游标。首页返回最近一页，但页内保持时间正序；下一页把
`nextBeforeSequence` 原样传回对应的 `messageBeforeSequence` 或
`operationBeforeSequence`。`thread.list`、`thread.browse`、`thread.open` 和 `thread.snapshot` 默认页大小
均为 `100`；显式 `limit` 的有效范围是 `1..500`，且不能超过初始化协商得到的
`limits.maxPageSize`。

Snapshot 的持久数据源是追加式 transcript 与 Tool ledger，因此不会因模型上下文压缩而
丢失新格式 Thread 的历史；但单次响应始终是分页结果。只有分别遍历 `messages` 与
`operations` 的所有页面后，才能称为恢复了可用的完整历史。

`OperationView` 不含 Tool `input`、`raw`、Provider metadata 或原始 evidence。Tool
展示值也会经过字段级 secret 清理和大小限制。`operation.get` 在 Operation ID 不存在时
返回 `{ "operation": null }`；Thread 本身不存在时仍返回 `THREAD_NOT_FOUND`。

## 事件

所有事件通过完整的 JSON-RPC Notification 发送。`1.3–1.6` envelope 显式区分 `durable` 与
`ephemeral`；两者仍保留进程内 `sequence`，但只有 durable event 具有可恢复身份：

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.event",
  "params": {
    "protocolVersion": "1.6",
    "runtimeInstanceId": "uuid",
    "sequence": 0,
    "timestamp": "2026-07-28T12:00:00.000Z",
    "threadId": "uuid",
    "turnId": "uuid",
    "durability": "durable",
    "eventId": "uuid",
    "cursor": "rte1:00000000-0000-4000-8000-000000000101:0:00000000-0000-4000-8000-000000000102",
    "event": { "type": "turn.started" }
  }
}
```

`params.turnId` 在 Schema 中可选。UI 结束活动 Turn、清理 waiter 或刷新 Snapshot 时，必须
同时匹配目标 `threadId + turnId`，不能把其他 Thread 或旧 Turn 的终止事件当作当前结果。

| `1.3–1.6` durability | event allowlist | 恢复语义 |
|---|---|---|
| `durable` | `turn.started`、`message.completed`、`tool.completed`（`1.5+` 含 `appOutput` 描述符）、`approval.required`、`approval.resolved`、`turn.completed`、`turn.cancelled`、`turn.failed`、`capabilities.changed`、`context.recovery.changed`（仅 `1.6`；向 `1.5` 及更早版本投影为 `capabilities.changed`） | 先事务提交事件日志，再发布 live；携带 `eventId` 与 `cursor`，可重放 |
| `ephemeral` | `message.started`、`message.delta`、`reasoning.summary.delta`、`reasoning.text.delta`（仅 `1.6` 且当前连接已通过 `reasoning.text.subscribe` 订阅）、`tool.started`、`tool.output` | 只有进程内 `sequence`；没有 `eventId` / `cursor`，不承诺重放 |

`approval.required` 在 `"1.0"` 是控制事件；在 `1.1–1.6` 仅为只读 View Event。
握手声明 `reasoning-summary` 时，客户端按 `runtimeInstanceId/threadId/turnId/reasoningId`
合并 `reasoning.summary.delta` 片段。能力声明不保证每轮都有摘要。公开摘要来源如下：

| 适配器 | 作为摘要展示的内容 |
|---|---|
| OpenAI Responses | 原生 `response.reasoning_summary_text.delta` |
| Claude Messages | 明确请求 `thinking.display: "summarized"` 后返回的 `thinking_delta` |
| Gemini Generate Content | 请求 `includeThoughts: true` 后，首个候选中标有 `thought: true` 的非空文本，按原顺序展示。见 [Google 文档](https://ai.google.dev/gemini-api/docs/generate-content/thinking#thought-summaries)。 |
| xAI Responses | 仅为明确配置的 `grok-4.7`，启用思考时接受 `response.reasoning_summary_text.delta` 和 `response.reasoning_text.delta`。[xAI 将这两者列为该型号的摘要](https://docs.x.ai/developers/model-capabilities/text/reasoning)。默认 `grok-4.5` 不声明此能力。 |

连接 Companion/Relay 时，公开摘要可发给远端客户端，并可从 Companion 的有界帧缓冲区重发。
Runtime 的持久事件历史不记录摘要。单个推理块超过 16,384 个 UTF-16 码元，或脱敏结果无法安全地接在已发文本之后时，
Runtime 只追加一次“后续内容已省略”的提示并停止展示该块。最终回答照常继续。

Claude 的签名和加密块、Gemini 的 `thoughtSignature`、Grok 的 `encrypted_content` 都不作为展示文本。

本地客户端可在 `1.6` 握手后发送 `reasoning.text.subscribe`，参数为 `{}`。若结果为
`{ "subscribed": true }`，当前连接可以收到 `reasoning.text.delta`，载荷含 `reasoningId` 和
`delta`。当前支持开启思考的 DeepSeek 和 Qwen（DashScope）返回的 `reasoning_content`。
未支持该方法的旧服务返回 JSON-RPC
`-32601`，不提供此能力的模型返回 `{ "subscribed": false }`。两种情况下客户端都可以继续对话。
订阅按连接生效，对订阅之后开始的轮次有效，断线重连需重新订阅。这类临时事件不进入公开事件监听器、历史重放或 Relay。

旧版 `session.*` 客户端可继续接收回答和工具事件。读取思考文本需使用上述 `1.6` 订阅；旧版消息查询不返回推理片段或 SDK 的 `providerOptions`。

原始模型推理块、流式消息/推理/工具输出增量、原始 Tool input/evidence、
上下文压缩内部诊断事件与 AI SDK `ModelMessage` 均不会写入 durable 事件日志。一旦底层存储提交失败，
Runtime 绝不发布无法持久恢复的 durable 实时事件。

### 持久事件恢复（1.3–1.6）

`runtime.events.resume` 在 `1.3–1.6` 可用。`afterCursor` 是该 Thread 已应用的 checkpoint；首次从
原始日志起点恢复时传 `null`。`null` 不表示“当前最早保留事件”：如果原始日志前缀已经被
裁剪，Runtime 必须返回 `EVENT_CURSOR_EXPIRED`，调用方先用 `thread.snapshot` 收敛。Runtime
使用专用、无副作用的 replay 发送路径逐条发送
`runtime.event`，随后才返回：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "throughCursor": "rte1:00000000-0000-4000-8000-000000000101:42:00000000-0000-4000-8000-000000000142",
    "replayedCount": 3
  }
}
```

Response 是 replay→live barrier，顺序固定为：

```text
开始暂存该 Thread 的并发 live durable event
  → replay notifications
  → runtime.events.resume response
  → 按 cursor 排序、按 eventId 去重后释放暂存的 live event
```

Client 不得在 Response 前把并发 live event 越过 replay 投递给业务层。Replay 只能恢复安全
投影，不能重新触发 Approval、User Input、Tool、Turn 或其他副作用；ephemeral event 永不
重放。`@roll-agent/client-node` 的 `createEventRecovery().resumeThread()` 封装了 Snapshot、
暂存、排序、去重和 barrier 校验，默认恢复暂存窗口为 10,000 条 / 32 MiB。

Snapshot fallback 必须使用
`thread.snapshot({ threadId, limit: 1, recovery: true })`。`1.3–1.6` Response 带
`recoveryProjection: true`，只保留安全的 Thread/checkpoint/active Turn 元数据（`1.6` 还包含可空的 `contextRecovery`），并将 `messages`、
`operations`、`pendingApprovals`、`pendingInteractions` 置为空；这样即使普通 Snapshot 同时含有大型
消息和大型审批预览，恢复 checkpoint 也始终可装入 `17 MiB` Client 帧。该投影不是完整 timeline，
Client 应在恢复完成后用普通 Snapshot 分页补载；typed Server Request 是未决 Interaction 的
权威来源。`1.0–1.2` strict 参数 Schema 不接受 `recovery`，结果 Schema 也不包含该标记。

每个 Thread 最多保留 10,000 条、16 MiB、30 天，只裁剪最老的连续前缀。若
`afterCursor` 已被裁剪，或传入 `null` 时原始日志前缀已经被裁剪，Runtime 返回
`EVENT_CURSOR_EXPIRED`；若 cursor 不属于该 Thread
的连续日志，返回 `EVENT_CURSOR_GAP`。两者都要求 Client 丢弃旧 checkpoint，重新读取
`thread.snapshot` 的 `eventCursor` 后收敛；检测到新的 `runtimeInstanceId`、cursor 冲突、
本地暂存溢出或 replay/live gap 时也必须走 Snapshot fallback。`1.0–1.2` 仍只支持
Snapshot 恢复。

## Runtime → Client Server Request

在 `1.1–1.6`（`"1.6"`、`"1.5"`、`"1.4"`、`"1.3"`、`"1.2"` 与 `"1.1"`）中，Approval 只有一条可写控制路径：Runtime 发出
`approval.request`，Client 用同一个 JSON-RPC `id` 返回结果。`approval.required`
仍可用于渲染审批卡片或观察 pending 状态，但 Client 不得据此调用
`approval.respond`；在这六个版本上调用该方法均会返回 `CAPABILITY_UNAVAILABLE`。
`1.2–1.6` 还要求 `approval.request` 已出现在最近一次 ACK 的 capability 集合中。
`1.2–1.6` 的 User Input 同样只有 `userInput.request` Result 这一条写入路径，并要求该 method
已出现在最近一次 ACK 中；没有 Handler 时 Runtime 不会把内建 `roll__user_input` Tool 暴露
给模型。

Runtime 会先登记并发送 `approval.request`，再发送对应的只读 `approval.required`
projection，避免 UI 快速响应时控制请求尚未存在。Client 仍应以 Server Request handler
为唯一决策入口，而不是依赖两条消息的相邻顺序维护业务状态机。

`1.2–1.6` Runtime Request：

```json
{
  "jsonrpc": "2.0",
  "id": "runtime:uuid",
  "method": "approval.request",
  "params": {
    "interactionId": "uuid",
    "threadId": "uuid",
    "turnId": "uuid",
    "expiresAt": "2026-07-29T12:10:00.000Z",
    "sensitivity": "normal",
    "approval": {
      "id": "uuid",
      "turnId": "uuid",
      "agentName": "browser-use-agent",
      "toolName": "click",
      "preview": { "selector": "#submit" },
      "reason": "此操作会提交表单"
    }
  }
}
```

`turnId` 必须与 `approval.turnId` 相同。当前仅允许
`sensitivity: "normal"`。Runtime 生成的 Approval 与 User Input deadline 均为
`min(now + 5 minutes, Turn 剩余期限)`；`expiresAt` 是绝对截止时间，显式重投不会延长它。
`1.1` wire 形状保持冻结：

```json
{
  "threadId": "uuid",
  "approval": {
    "id": "uuid",
    "turnId": "uuid",
    "agentName": "browser-use-agent",
    "toolName": "click",
    "preview": { "selector": "#submit" },
    "reason": "此操作会提交表单"
  },
  "expiresAt": "2026-07-29T12:10:00.000Z"
}
```

其中 `1.1` `expiresAt` 仍可省略，且没有 `interactionId`、顶层 `turnId` 或
`sensitivity`。`1.0` 不发送 Server Request，继续使用 `approval.required` +
`approval.respond`。

### User Input（1.2–1.6）

`userInput.request` Params 使用相同 Interaction metadata，并携带 1..16 个结构化 control：

```json
{
  "interactionId": "uuid",
  "threadId": "uuid",
  "turnId": "uuid",
  "expiresAt": "2026-07-29T12:10:00.000Z",
  "sensitivity": "normal",
  "title": "配置部署目标",
  "controls": [
    {
      "type": "choice",
      "id": "region",
      "label": "部署区域",
      "required": true,
      "multiple": false,
      "options": [{ "id": "east", "label": "东区" }]
    },
    {
      "type": "text",
      "id": "workspace",
      "label": "目标 Workspace",
      "required": true,
      "maxLength": 120
    }
  ]
}
```

control 类型固定为 `text | multiline | number | boolean | choice`。control ID 最长 64、
label 最长 200、description 最长 500；choice 最多 50 个稳定 ID option，文本绝对上限
10,000 字符。当前仅允许 `sensitivity: "normal"`，不定义 password、token、secret、
authentication 或 file-picker 字段。

提交与正常取消结果分别为：

```json
{ "status": "submitted", "values": [{ "id": "workspace", "value": "product-docs" }] }
```

```json
{ "status": "cancelled", "reason": "用户关闭了表单" }
```

Runtime 必须结合原始 Params 二次校验必填项、类型、未知/重复 ID、choice option 与数量边界，
再按 control 定义顺序规范化。等待期间 `1.2–1.6` Snapshot 使用 `waiting-for-user`，默认 deadline
为 5 分钟或 Turn 剩余期限中的较小值；旧协议投影仍为 `running`。Result 只返回当前 Tool
调用，完整值不会进入 Runtime Event 或 Snapshot。

批准与拒绝都是成功的业务结果：

```json
{ "jsonrpc": "2.0", "id": "runtime:uuid", "result": { "decision": "approve" } }
```

```json
{
  "jsonrpc": "2.0",
  "id": "runtime:uuid",
  "result": { "decision": "reject", "reason": "用户取消" }
}
```

Handler 不存在时返回 `-32601`，参数非法时返回 `-32602`，Handler 抛错或返回非法结果时
返回 `-32603`。Runtime 对 Client error 或非法结果采取 fail-closed：先把 Approval 收敛为
`cancelled`，再以 `turn.failed` 结束 Turn；它不会默认批准，也不会伪装成用户主动拒绝。

JSON-RPC `id` 只负责当前投递的 Request/Response 关联；`1.2–1.6` `interactionId` 负责逻辑
Interaction；`approval.id` 是跨 View、Snapshot 和审计使用的业务 ID。三者与 mutation
`requestId` 均不能互换。

### 取消与最终状态

Turn 取消、Turn 终止、deadline、capability 撤销或 Runtime 关闭时，Runtime 会尽力发送取消通知。
`1.2–1.6` 形状是：

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.serverRequest.cancel",
  "params": {
    "interactionId": "uuid",
    "reason": "Turn 已由客户端取消"
  }
}
```

`1.1` 形状原样保留：

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.serverRequest.cancel",
  "params": {
    "serverRequestId": "runtime:uuid",
    "approvalId": "uuid",
    "reason": "Turn 已由客户端取消"
  }
}
```

Client 必须终止对应的本地交互，且不得在取消后发送迟到 Response。合法决议完成后，或请求
因错误、取消而失效后，Runtime 用 `approval.resolved` 收敛当前 View：

```json
{
  "type": "approval.resolved",
  "approvalId": "uuid",
  "resolution": {
    "status": "resolved",
    "decision": "reject",
    "reason": "用户取消"
  }
}
```

`resolution` 的稳定形态为：

- `{ status: "resolved", decision: "approve" }`
- `{ status: "resolved", decision: "reject", reason? }`
- `{ status: "cancelled", reason }`
- `{ status: "expired", reason? }`

`"1.0"` 不发送 `approval.resolved`。人工审批与 User Input 不使用普通 Client `30s` RPC timeout；
生命周期由 `expiresAt`、Response、显式取消、Turn 终态、capability 撤销或连接关闭控制。

当前 `stdio` Transport 是单连接、进程绑定的边界。一个 `RuntimeService` 只接受一个
活动 `RuntimeProtocolAdapter` 控制连接；第二个 Adapter 会被拒绝，而不是竞相处理同一
Interaction。`1.3–1.6` 的事件恢复不会重放 Server Request；断线后没有持久 Interaction
replay/resume，未决 Server Request 会被取消，Runtime
随关闭流程 fail-closed 结束 Session。Client 重新启动后必须读取 Snapshot 收敛，不能
重投旧 JSON-RPC `id`。

Runtime 内部 Coordinator 跟踪当前进程内的 pending Interaction，并校验
`interactionId + JSON-RPC id + eligible responder + runtimeInstanceId`。显式重投生成新
JSON-RPC `id`，但复用原 `interactionId` 和 deadline。连接断开会取消该 responder 的
全部未决 Interaction；Coordinator 不承诺持久 `seq/ack/resume`、跨进程 responder
恢复或任意连接 first-wins。

这条 wire 路径不改变 `roll chat` TUI。TUI 仍在进程内通过既有 `clack` 选择式确认与
`AgentSession` 交互，不经过 Runtime Protocol Server Request。

## 错误

JSON-RPC 标准错误：

| code | 含义 |
|---:|---|
| `-32700` | Parse error |
| `-32600` | Invalid Request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |

Roll 领域错误使用 `error.data`：

```json
{
  "rollCode": "THREAD_NOT_FOUND",
  "retryable": false
}
```

Runtime 领域错误的外层 JSON-RPC `error.code` 为 `-32000`；参数 Schema 校验失败使用
`-32602`，并附带 `rollCode: "INVALID_PARAMS"`。稳定 `rollCode` 为：

| `rollCode` | 含义 |
|---|---|
| `PROTOCOL_VERSION_UNSUPPORTED` | 没有共同协议版本 |
| `INITIALIZE_REQUIRED` | v1 方法调用前尚未初始化 |
| `INVALID_PARAMS` | 参数或幂等 ID 使用冲突 |
| `THREAD_NOT_FOUND` | Thread 不存在 |
| `THREAD_BUSY` | Thread 当前不能执行该操作 |
| `TURN_NOT_FOUND` | Turn 不存在或已结束 |
| `TURN_ALREADY_ACTIVE` | Thread 已有活动 Turn |
| `APPROVAL_NOT_FOUND` | Approval 不存在或已失效 |
| `CAPABILITY_UNAVAILABLE` | 当前 Runtime 不支持所需能力 |
| `CAPABILITY_REVISION_CONFLICT` | `1.2–1.6` capability revision 过旧，或同 revision 配不同集合 |
| `EVENT_CURSOR_EXPIRED` | `1.3–1.6` checkpoint 已被连续前缀裁剪；重新读取 Snapshot |
| `EVENT_CURSOR_GAP` | `1.3–1.6` cursor 不属于可连续恢复的 Thread 日志；重新读取 Snapshot |
| `ATTACHMENT_NOT_FOUND` | `1.4+`：`attachmentId` 不存在、已释放、已过期回收，或不属于请求的 `threadId` |
| `ATTACHMENT_NOT_COMMITTED` | `1.4+`：`turn.start` 引用了尚未 `commit` 的附件 |
| `ATTACHMENT_TOO_LARGE` | `1.4+`：声明或实际字节数超过 `maxAttachmentBytes`，或 chunks 累计超过声明字节数 |
| `ATTACHMENT_TYPE_UNSUPPORTED` | `1.4+`：`mediaType` 不在支持列表，或文件扩展名与 `mediaType` 不匹配 |
| `ATTACHMENT_HASH_MISMATCH` | `1.4+`：实际内容 sha256 与声明不符；chunks 来源在 `commit` 时触发并回收已上传数据，local-path 来源在 `stage` 时触发、不产生附件记录 |
| `ATTACHMENT_QUOTA_EXCEEDED` | `1.4+`：保留中的附件数（含已 `commit` 未 `release`）已达 `maxStagedAttachments`；先 `attachment.release` 或等待 TTL 回收 |
| `ATTACHMENT_UPLOAD_INCOMPLETE` | `1.4+`：chunks 来源 `commit` 时累计字节数不等于声明值 |
| `ATTACHMENT_PATH_REJECTED` | `1.4+`：local-path 来源不是绝对路径、不可 `lstat`、是 symlink 或不是普通文件 |
| `RUNTIME_CLOSING` | Runtime 正在关闭 |
| `OUTCOME_UNKNOWN` | 副作用结果无法确认 |
| `INTERNAL_ERROR` | 未分类内部错误 |

合法 JSON-RPC 错误的 `id` 可能是 `null`。这类错误无法关联到任一挂起请求，客户端不得猜测
归属；`@roll-agent/client-node` 会将其视为 `RollUncorrelatedRpcError` 并关闭连接。
Runtime 收到 Client 的 `id: null` Error 时同样会拒绝全部未决 Server Request 并关闭
连接，确保 Approval fail-closed，而不是无限等待人工决定。

## 幂等与未知结果

- 进入 mutation 幂等缓存的方法：`thread.create`、`thread.rename`、`thread.delete`、
  `thread.detach`、`turn.start`、`turn.cancel`（全部版本）；`approval.respond`（仅 `"1.0"`）；
  `attachment.stage`、`attachment.chunk`、`attachment.commit`、`attachment.release`（`1.4–1.6`）；
  `thread.model.set`、`runtime.modelConfig.reload`（`1.6` 可选扩展）。
  上述 mutation 都携带 UUID `requestId`；
- 同一 `runtimeInstanceId` 内，最近 `limits.idempotencyCacheEntries` 个已完成 mutation
  会缓存其成功或失败结果；相同 `requestId` + 相同参数在该窗口内返回同一结果；
- 执行中的 mutation 单独保留，不占用已完成结果的容量，也不会为了满足上限而被淘汰；
- `turn.start` 还使用客户端生成的 `turnId` 去重：活动 Turn 始终保留，最近
  `limits.idempotencyCacheEntries` 个已完成 Turn 使用独立 LRU 窗口保留；
- 保留窗口内，相同 `requestId` 被用于不同方法或参数时返回 `INVALID_PARAMS`；
- 客户端必须为每次新的 mutation 生成全新 `requestId`，不得在窗口淘汰后重用旧 ID；
- 客户端必须为每个逻辑 Turn 生成全新 `turnId`；已完成 Turn 被淘汰后，Runtime
  不再保证旧 `turnId` 的去重；
- Runtime 退出后，客户端不得自动重放未确认结果的副作用命令。

Node 客户端默认只对服务端明确标记为 `retryable` 的只读请求重试一次，其中不包含
`thread.open`。它不自动重试副作用请求，并把连接失败时仍活动或写入结果不明确的 Turn
标记为 `outcome unknown`。UI 应停止本地 Working 状态、保留已显示内容、不自动重放，
然后在健康连接上或重连后通过 Snapshot 收敛。

请求超时、帧限制、错误类、`onExit()` 语义以及
stdin close → SIGTERM → SIGKILL 的有界关闭流程，见
[`@roll-agent/client-node` API 参考](./client-node-reference.md)。

## Protocol 1.5 结构化应用输出（App output）

当 `initialize` 返回的 `features` 包含 `"app-output"` 时，客户端可调用只读方法
`operation.result.get`（参数为 `{ threadId, operationId }`）按需读取工具的有界结构化输出。
若目标 Operation 不存在，响应为 `{ result: null }`；否则返回
`{ result: { threadId, operationId, agentName, toolName, createdAt, output } }`。
其中 `output.status` 可能为 `available`、`not_provided`、`invalid`、`too_large`、`expired`、
`denied` 或 `rejected`（因检测到疑似凭据字段或凭据值被拦截）。仅当状态为 `available` 时，
`output` 才会包含 `schemaId`、`schemaVersion`、`remoteReadable`、完整的 JSON 对象 `data`
以及纯文本兜底摘要 `fallbackText`。

在协议 `1.5–1.6` 中，`OperationView` 与 `tool.completed` 事件仅携带轻量的 `appOutput` 描述符，
绝不直接内联完整的 `data`；向 `1.4` 及更早版本投影时会自动剥离该描述符。客户端应在界面展示需要时
（包括断线重连后）按需调用 `operation.result.get` 拉取完整结果。单条结果上限 `256 KiB` 与单个
JSON Schema 上限 `32 KiB` 均按 UTF-8 编码后的字节数计算；一旦超出上限，整份 `data` 将被省略并标记为
`too_large`。每个 Thread 最多保留 `16 MiB`、`2,000` 条结果记录或 `30` 天，会话分支（fork）继承原记录的过期时间。
注意：结构化输出校验失败并不证明工具未曾执行，客户端严禁据此自动重试工具调用。

## Protocol 1.6 上下文恢复状态（Context recovery）

在协议 `1.6` 中，完整 Snapshot 与 `recoveryProjection: true` 恢复投影均包含必需的可空字段
`contextRecovery`：当前无恢复记录时为 `null`，否则为
`{ checkpointId, required, unextracted, requiredItemCount }`。其中 `required` 表示写工具仍受恢复门禁限制、尚未完成上下文恢复，`unextracted` 表示归档历史原文尚未完成语义提取，`requiredItemCount` 统计当前目标与全部活跃约束项数量。该视图对象仅暴露有界状态计数，不包含模型笔记、历史原文或内部回执（receipt）。

`context.recovery.changed` 是持久视图事件（durable View Event），进入、退出恢复状态或切换
`checkpointId` 时均会更新该投影；SQLite 会话重开与 `runtime.events.resume` 重放共用同一事件定义。
向 `1.5` 及更早版本投影时，Snapshot 会剥离 `contextRecovery` 字段，`context.recovery.changed`
事件则兼容映射为 `capabilities.changed`，从而保持 `eventId` 与 `cursor` 序列连续不中断。
上下文恢复门禁解除并不等同于用户授权，既有的安全策略与工具审批规则继续独立生效。

## 文件审批完整预览（1.6 可选扩展）

`approval.preview` 是只读方法，用于按页读取仍处于待处理状态的审批完整变更快照，本身不会触发文件写入或完成批准。
当 `PendingApproval.preview.fullDiffAvailable` 为 `true` 时，客户端可渲染“查看完整变更”入口。

请求参数为 `{ threadId, turnId, approvalId, offset?, maxChars? }`，其中 `offset` 默认为 `0`，
`maxChars` 默认为 `12000`、最大为 `32000`。响应格式为 `{ text, totalChars, nextOffset }`：偏移量按
UTF-16 码元（code units）计算，`nextOffset` 为 `null` 时表示已读到末尾。服务端在分页切片前先对整份快照执行统一脱敏，客户端随后按返回的 `nextOffset` 顺序续读；所有分页均读取自同一次审批锁定的内存快照，不会重新读取磁盘上的当前文件。若审批已结算、已过期、无完整预览或关联标识不匹配，服务端返回 `APPROVAL_NOT_FOUND`。完整预览正文不会写入持久事件日志或工具账本。

首屏内联的 `preview.diff` 始终保持有界大小。若 `coarse: true`，代表未生成逐行 diff，此时 `removed` / `added` 分别表示修改前后的文件总行数，完整预览正文则为明确分段的修改前原文与修改后新文；UI 应将其展示为“全文对照”，不得将这些数字当作精细的增删行统计。一旦目标文件内容版本发生变化，原待决审批即刻失效——即便同一工具批次中的其他工具更新了读取追踪记录，也必须重新读取、重新生成预览并重新发起审批。该方法不会扩展 `1.0–1.5` 或旧版 `session.*` RPC 的方法集合，也不会隐式加入远程 Relay 的默认请求白名单。
