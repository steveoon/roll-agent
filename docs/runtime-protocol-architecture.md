# Roll Runtime Protocol 的架构与边界

## 结论

第三方 UI 的稳定接入边界是版本化 `Roll Runtime Protocol`；`ConversationEngine`
仍是内部执行引擎，stdio 只是首个本地 Transport。

```text
Electron / Tauri / Qt / Python / IDE / Gateway
          │ Request / Notification / Response
          ▼
 Roll Runtime Protocol v1.3
          │ JSON-RPC + NDJSON + stdio
          ▼
 RuntimeProtocolAdapter（连接级协商）
          │
          ├── RuntimeClientRequestCoordinator（双向 RPC 关联）
          │
          ▼
 RuntimeService（Thread / Turn / Approval 权威状态）
          │
 ConversationEngine + ThreadStore + AgentSession
```

## 为什么不直接公开 `ConversationEngine`

直接嵌入 `ConversationEngine` 会让宿主负责配置加载、Provider、Policy、Skill/Agent
发现、ThreadStore、Shell 环境和生命周期。任何构造参数或初始化顺序变化都可能影响第三方。

`RuntimeService` 把这些内部对象投影为稳定领域对象：

- `Thread`：持久会话；
- `Turn`：一次执行；
- `UiMessage`：仅面向 UI 的文本消息；
- `OperationView`：脱敏 Tool 执行投影；
- `PendingApproval`：可由宿主展示的审批请求。

Embedded Runtime SDK 仍可用于 Roll 第一方或版本锁定的高级宿主，但不与 Runtime Protocol
共享兼容性承诺。

具体 wire 契约见 [Runtime Protocol v1 参考](./runtime-protocol-v1-reference.md)；Node
生命周期封装见 [`@roll-agent/client-node` API 参考](./client-node-reference.md)。

## 领域协议与 Transport 分层

| 层 | 当前选择 | 稳定性 |
|---|---|---|
| 领域协议 | `Thread` / `Turn` / `Approval` / `Operation` | 公共 v1 契约 |
| 信封 | JSON-RPC 2.0 | 公共契约 |
| 分帧 | 一行一个 JSON（NDJSON） | stdio Adapter 契约 |
| Transport | stdio | v1 正式入口 |

协议版本从 `"1.0"` 开始，当前最新版本为 `"1.4"`，与 npm 包版本独立。未来增加
Transport 时，不需要改变 Thread、Turn 或事件语义。

`RUNTIME_PROTOCOL_VERSION` 只表示协议包中的最新 wire schema，不代表每个 Client 自动拥有
该版本的入站能力。1.3/1.2 保持 `initialize` 的 strict 形状，并在协商完成后通过
`client.capabilities.set` 申明当前可处理的 Server Request method。1.1/1.0 Client
继续按原契约回退，不能把 1.2 capability 字段塞入旧握手。

## Runtime → Client 双向 RPC

`"1.1"` 把 Approval 从 Event + mutation 特例升级为 Runtime 发起的 typed Server
Request；`"1.2"` 再把内部生命周期推广为 method-agnostic Interaction，并加入显式
Client capability revision：

```text
AgentSession 等待 ApprovalGate
          │
          ▼
RuntimeService 登记 PendingApproval
          │
          ▼
RuntimeClientRequestCoordinator
  ├─ 保存 interactionId、method、目标 responder、Runtime scope 和原始 deadline
  └─ 为本次投递生成 JSON-RPC id
          │ approval.request
          ▼
Client handler / GUI
          │ typed Result
          ▼
RuntimeService.resolvePendingApproval()
          │
          ▼
ApprovalGate 继续或拒绝
```

职责边界：

| 层 | 持有 | 不持有 |
|---|---|---|
| `RuntimeService` | Interaction 对应的领域权威状态、Turn 归属、最终决议、终态顺序 | JSON-RPC correlation |
| `RuntimeClientRequestCoordinator` | 当前进程的逻辑 Interaction、投递 ID、eligible responder/scope 校验、取消、deadline、显式重投 | Tool policy、持久化与跨进程恢复 |
| `RuntimeProtocolAdapter` | 连接级版本协商、typed wire 转换 | 可跨连接存续的业务状态 |
| Client / GUI | 已 ACK capability 对应的临时交互 UI | Thread/Turn 权威状态、跨进程恢复和最终状态 |

本地 Runtime 1.3/1.2 Interaction 链路中的身份不能混用：

| ID | 生命周期 | 用途 |
|---|---|---|
| JSON-RPC `id` | 单次连接上的一次投递 | Server Request 与 Response 关联 |
| `interactionId` | 一次逻辑 Interaction | 显式重投、取消与迟到结果去重；1.2 cancel 使用该 ID |
| `approvalId` | Approval 领域对象 | Snapshot、审计与 Approval View；不是通用 Interaction ID |
| mutation `requestId` | Client → Runtime mutation | `turn.start` 等写操作幂等 |

`approvalId` 是业务对象 ID；接入远程 Relay 后还会增加 Relay request 与 delivery
cursor。它们的完整跨层关系见下文。

Coordinator 可在当前进程内对 eligible responder 执行显式重投：新的 JSON-RPC `id`
仍引用同一个 `interactionId`，且不会延长原始 deadline。stdio Host 仍使用断线即取消
策略，不保留可跨进程恢复的 Request；持久 Relay 的 `seq/ack/resume`、responder 身份
恢复和跨进程存储属于后续协议层。

当前 v1 stdio Host 明确限制一个 `RuntimeService` 同时只能绑定一个
`RuntimeProtocolAdapter` 控制连接，避免两个 GUI Controller 竞相投递或完成同一
Approval。多窗口观察者、Controller 转移和重连重投需要未来的 responder registry 与
Relay 可靠传输语义，不能仅凭当前连接内的 Coordinator 推导出来。

每条连接第一次使用 `initialize`/Runtime 方法或 legacy `session.*` 方法时即锁定协议家族，
不能在同一连接混用。普通 `roll chat` TUI 直接使用进程内 `AgentSession` 与既有 `clack`
确认，不经过这条 Server Request 链路。

## 持久事件恢复与 Snapshot 收敛

1.3 把事件分为两类：

- durable：Turn 状态、完整消息、安全 Tool 完成投影、安全 Approval 状态和 capability
  变更。Runtime 必须先把事件与 cursor 事务提交到 Thread 事件日志，再发布 live；Store
  失败时不能发布不可恢复的 durable event。
- ephemeral：Token/message/reasoning/tool-output delta 与开始态，只带进程内 `sequence`，
  不进入持久日志。

`RuntimeEventEnvelope.sequence` 仍只在当前 `runtimeInstanceId` 内单调递增；1.3 durable
event 另有互不兼容的 `eventId` 与不透明 Thread `cursor`。客户端恢复顺序是：先暂存并发
live durable event，再调用 `runtime.events.resume({ threadId, afterCursor })`；Runtime 逐条
发送 replay notification，最后的 RPC Response `{ throughCursor, replayedCount }` 构成
replay→live barrier。Client 只能在收到 Response 后按 cursor 排序、按 eventId 去重并释放
暂存 live event。

Replay 使用专用无副作用发送路径，不能重新触发 Approval、User Input、Tool、Turn 或其他
执行。每个 Thread 保留 10,000 条、16 MiB、30 天，只裁剪最老连续前缀；
`afterCursor: null` 固定表示原始日志起点，若该起点已经被裁剪则返回
`EVENT_CURSOR_EXPIRED`。cursor 过期或出现 gap、Runtime instance 变化或 Client 检测到 stream
gap 时都回退 `thread.snapshot`。1.3 Snapshot 的 `eventCursor` 是新的恢复 checkpoint；
1.2/1.1/1.0 继续只使用 Snapshot。

Snapshot 从追加式 transcript 与 Tool ledger 构造，不读取可能已被上下文压缩的活动模型消息，
并恢复活动 Turn、安全 `pendingInteractions` 与 UI 投影。结果未知的副作用命令始终不能自动
重放；Runtime 崩溃时仍未终止的 Turn仍显示 `outcome unknown`。

## 本地与远程信任边界

`RuntimeServer` 只接受可信本地 Transport，不负责网络认证或租户隔离，也不会直接监听公网。

远程 Web 使用单独的 Companion Relay Protocol：

```text
Next.js Browser
      │ HTTPS / WSS
      ▼
Cloud Relay
      │ 仅设备绑定、路由、ACK
      ▼
Local Companion（主动出站）
      │ Runtime Protocol
      ▼
用户本机 Roll 与 Workspace
```

远程层分成三个公开 package 边界与一个 Core 内部 Host：

| 包 | 负责 | 不负责 |
|---|---|---|
| `@roll-agent/relay-protocol` | Relay Wire、Browser Control、方向 allowlist、ID Schema、JSON Schema、fixtures、TypeScript types | Transport、账号、数据库、Policy、部署 |
| `@roll-agent/relay-client` | Browser session、correlation、Chat/Interaction reducer、ACK/gap、重连和 Snapshot 收敛 | React UI、第三方登录、Cloud Relay 管理 API、raw frame API |
| `@roll-agent/companion` | 消费 Relay 契约；提供本机 bridge、Workspace lease、本地 Policy、ACK/gap 缓冲、去重与出站重连 | 定义第二套 Wire Schema、生产 Cloud Relay、Browser 业务状态机 |
| `@roll-agent/core` 内部 Companion Host | `roll companion`、设备凭据、Workspace 映射、Runtime supervision、本机 IPC 与 per-user 服务 | 稳定 Host SDK、Cloud Relay、第三方业务 UI |

对应的安装与激活边界是：

| 产品组件 | 安装 | 激活方式 |
|---|---|---|
| Local-only Desktop | `@roll-agent/client-node`，按需加 `@roll-agent/protocol` | Desktop Main 显式启动本地 stdio Runtime |
| Browser Web App | `@roll-agent/relay-client` | 第三方后端先兑换短期 session，Client 再连接认证 Relay |
| Cloud Relay | `@roll-agent/relay-protocol` | 生产服务负责账号、路由与可靠投递 |
| Local Companion Host | 官方签名安装包 / `@roll-agent/core` 开发安装 | `roll companion service install` + enrollment；服务只建立出站 WSS |

`@roll-agent/companion` 仍是低层库，不是第三方必须组装的产品 Host。官方 daemon 位于 Core
内部并只通过 `roll companion` 管理；P0 不发布稳定 `companion-host` SDK。npm 安装不会自动
enrollment 或启动服务；普通 `roll chat`、Local-only Electron 和
`roll runtime serve --stdio` 也不会创建 Relay 连接。

`authentication.request` 与 File Picker 没有远程 projector，保持 local-only。Runtime 1.3
event replay 只恢复既有安全事件投影，不会把这类本地能力带入 Relay；未来启用必须先完成
安全 RFC #186。

Cloud Relay 与高级自定义 Transport 直接以 `@roll-agent/relay-protocol` 校验 frame；普通
Browser App 使用 `@roll-agent/relay-client`，不能为了处理 Wire 而依赖整个
`@roll-agent/companion`。

Relay Wire 1.1 提供通用 `interaction.request/resolved/cancelled` 与
`interaction.candidate`；冻结的 1.0 继续只承载 Approval 专属路径。Runtime 1.3 的 event
cursor 不会被投影成 Relay ACK，也不能静默扩大任一 Relay registry。

push event 与 pull query 使用同一安全边界。Wire 1.1 的 `thread.open` / `thread.snapshot`
必须经 `projectRelayThreadSnapshotV11()`，`operation.get` 必须经
`projectRelayOperationGetResultV11()`；projector 遇到畸形 Runtime 结果会 fail closed。
`CompanionRelayBridgeV11` 自动应用这些 projector，并把错误收敛为稳定 code、retryable 与
固定公开文案；自定义 Host 必须在构造 `runtime.response` 前显式执行相同投影，不能回传 Runtime
或本地 Policy 的原始错误消息。冻结 Wire 1.0 不具备该远程安全保证，仅限等价本地信任边界
内的 legacy peer；面向 Cloud/Browser 时协商失败必须拒绝连接。

跨层接线必须区分以下 correlation、幂等与投递标识：

| 标识或游标 | 所属层 | 语义 |
|---|---|---|
| Runtime JSON-RPC `id` | Runtime ↔ Local Client/Companion | 当前本地连接上的一次 Request/Response 投递 |
| Runtime `interactionId` | Runtime typed Interaction | 当前进程内显式重投保持稳定；不提供跨进程 Server Request 恢复 |
| Relay `requestId` | Browser/Cloud Relay ↔ Companion | Relay response correlation、重投、冲突检测与响应缓存 |
| Runtime mutation `params.requestId` | Client/Companion → Runtime | `turn.start` 等 Runtime 写操作幂等 |
| Runtime `eventId` / `eventCursor` | 单 Thread durable event 日志 | 事件去重、replay 与 Snapshot checkpoint |
| Relay `relaySequence` / ACK | 单 Workspace Relay 投递流 | Relay generation 内排序、重投与确认 |

`RuntimeEventEnvelope.sequence` 只在当前 `runtimeInstanceId` 内递增；Runtime event cursor
按 Thread 标识持久日志位置；Relay `relaySequence`/ACK 只描述单 Workspace 的安全投影投递
进度。三者即使数值相同也没有等价关系：Relay ACK 不能确认 Runtime cursor，Runtime 也
不能用 Relay cursor 续接事件。#176 不修改 Relay Wire 或增加持久 Relay outbox。

`@roll-agent/companion` 当前实现的低层本地基础能力：

- Browser client 与后台 Shell lease 由认证宿主手动接线；
- 只有经 `CompanionWorkspace.startTurn()` 发起的 Turn 自动持有 lease；
  `CompanionInteractionBroker` 处理 Runtime `"1.3"` / `"1.2"` 的 Approval/User Input，并为
  Runtime `"1.1"` Approval 提供兼容 facade，在 Result/Abort/deadline/Turn 终态时只结算一次；
  deprecated `CompanionApprovalRequestBroker` 只作为一个 minor 周期的 legacy API 保留；
- Browser lease 释放不会关闭仍有 Turn、Shell 或 Interaction lease 的 Runtime；
- 最多缓冲 `10,000` 个事件或 `32 MiB`，溢出时返回 gap 并要求 Snapshot；
- Relay bridge 只对 mutation 的 `workspaceId + requestId` 做有界响应缓存，并以
  SHA-256 指纹校验参数；活动请求不淘汰，已完成结果按 LRU 保留，读取请求不缓存大型
  Snapshot；
- ACK 只能推进到当前连接已成功发送的最高事件序号；每次重连使用独立发送队列，旧连接
  中阻塞的发送或加密任务不会阻塞新连接握手与事件恢复；
- 完全重复投递复用原 mutation 结果，相同 ID 配不同参数会被拒绝；Runtime 仍以协商得到
  的有界 `requestId` 与已完成 `turnId` 窗口作为第二道幂等边界；
- Relay Wire `"1.1"` 的 Browser 候选统一通过 `interaction.candidate` 提交；冻结 Wire
  `"1.0"` 只在受信 legacy peer 内保留 Approval 专属路径：其事件投影中的 Runtime 兼容版本为
  `"1.1"` 时使用 `approval.candidate`，为 `"1.0"` 时使用 `approval.respond`。候选成功只表示
  `{ accepted: true }`；Runtime 权威终态仍由有序 Event 给出。外层 Wire `"1.0"` 不代表
  Runtime 审批能力，也不能承载 Runtime `"1.3"` / `"1.2"` 新字段；
- 远程 approve 候选仍经过本地 Policy；`require-local-confirmation` 会返回
  `LocalConfirmationRequiredError`，不会自行创建确认 UI；远程拒绝只会收窄权限，可直接
  返回拒绝；
- cipher-bound Workspace 只接受 `runtime.encrypted` 请求；明文请求在触达 Runtime 前以
  `RELAY_ENCRYPTION_REQUIRED`、`retryable: false` 拒绝，response/event 也只发送加密信封。

Wire 1.1 Host 还必须为每次连接提供 `requestPolicy`。Bridge 会在 request cache 与 Runtime
dispatch 之前对每个 `runtime.request` 调用它；拒绝只返回稳定的
`REMOTE_REQUEST_DENIED`。官方 P0 Host 只允许绑定 Workspace 的 Thread list/create/open/
snapshot/capabilities、Turn start/cancel、Operation get 与 Interaction candidate。

上述 Relay buffer、ACK、幂等缓存和 lease 都是 Companion 进程内状态，不是持久队列。
Companion 重启后，宿主必须重建连接与 lease；本地 Runtime 协商到 1.3 时可用 durable
event replay，否则使用 `thread.snapshot` 收敛 UI。Relay ACK 只推进 `relaySequence`，不会
确认 Runtime event cursor。

独立 `roll-cloud-relay` 服务必须另外实现：

- Cloud Relay Server、账号/设备绑定存储、鉴权授权与 Workspace 路由；
- TLS、Browser session、持久设备绑定、心跳、帧上限、限流、HA、监控和协议诊断；
- Browser 连接身份到 `attachBrowser()` / `detachBrowser()` 的可信控制面；
- Shell lease 生命周期；
- cipher 的算法、AEAD、nonce、密钥协商/轮换、Browser 实现和密钥存储。

官方 P0 Companion 不启用本机二次确认：Runtime `runtime.approval` 的 `auto/confirm/deny` 是
唯一事实源；Web 只能完成 Runtime 已产生的 `confirm` Interaction，不能越过 `deny`。低层
`@roll-agent/companion` 仍保留可收窄权限的本地 Policy，供未来高级宿主使用。

即使启用 payload cipher，Relay 仍可读取 Workspace ID、payload kind、request ID 或
sequence 等路由元数据。`@roll-agent/companion` 不包含生产 Cloud Relay 服务；其精确消息、
缓存与关闭语义见
[`@roll-agent/relay-protocol` Relay v1 参考](./companion-relay-v1-reference.md)。

公网多租户云端 Roll 必须按租户或 Workspace 使用独立 Worker。多个不可信租户不能共享一个
Roll 进程、工作目录、环境变量或 Shell。

## v1 明确不覆盖

- 附件和二进制传输；
- Artifact 生命周期；
- Workflow DAG；
- 权限 DSL；
- stdio 之外的 Runtime Transport；
- Runtime 崩溃后的自动执行恢复；
- 生产 Cloud Relay、Relay HA 或持久 Browser outbox；
- Runtime Server Request 的持久重投、持久 Relay outbox 与跨进程 responder 恢复。

这些能力可以在不破坏 v1 基础对象的前提下逐步扩展。
