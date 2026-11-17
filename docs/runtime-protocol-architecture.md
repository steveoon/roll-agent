# Roll Runtime Protocol 的架构与边界

## 结论

第三方 UI 的稳定接入边界是版本化 `Roll Runtime Protocol`；`ConversationEngine`
仍是内部执行引擎，stdio 只是首个本地 Transport。

```text
Electron / Tauri / Qt / Python / IDE / Gateway
          │ Request / Notification / Response
          ▼
 Roll Runtime Protocol v1（最新 1.6）
          │ JSON-RPC + NDJSON + stdio
          ▼
 RuntimeProtocolAdapter（连接级协商）
          │
          ├── RuntimeClientRequestCoordinator（双向 RPC 关联）
          │
          ▼
 RuntimeService（Thread / Turn / Approval / Interaction 权威状态）
          │
 ConversationEngine + ThreadStore + AgentSession
```

## 为什么不直接公开 `ConversationEngine`

直接嵌入 `ConversationEngine` 会让宿主自行承担配置加载、Provider 装配、策略执行、Skill/Agent
发现、`ThreadStore`、Shell 环境与进程生命周期管理，内部构造参数或初始化顺序的任何演进都会波及第三方应用。

`RuntimeService` 将内部状态投影为稳定的协议领域对象：

- `Thread`：持久会话；
- `Turn`：单轮执行；
- `UiMessage`：面向 UI 的脱敏消息（`1.4+` 可含安全附件元数据片段）；
- `OperationView`：脱敏 Tool 执行投影（`1.5+` 含 `appOutput` 状态描述符）；
- `OperationResultView`：`1.5+` 按需读取的有界结构化工具输出（`appOutput`）；
- `PendingApproval`：可由宿主展示的待处理审批请求；
- `PendingInteraction`（`PendingInteractionProjection`）：`1.2+` 当前响应方尚未结算的安全交互投影（覆盖审批与结构化用户输入）；
- `AttachmentDescriptor`：`1.4+` 不含二进制内容与客户端本地路径的安全附件元数据；
- `ContextRecoveryView`：`1.6` 上下文压缩后的有界恢复门禁状态投影。

Embedded Runtime SDK 仍可供 Roll 第一方组件或锁定内部版本的高级宿主使用，但不提供与 Runtime Protocol
等价的跨版本兼容承诺。

具体 wire 契约见 [Runtime Protocol v1 参考](./runtime-protocol-v1-reference.md)；Node
进程生命周期封装见 [`@roll-agent/client-node` API 参考](./client-node-reference.md)。

## 领域协议与 Transport 分层

| 层 | 当前选择 | 稳定性 |
|---|---|---|
| 领域协议 | `Thread` / `Turn` / `Approval` / `Interaction` / `Operation` / `Attachment` | 公共 v1 契约 |
| 信封 | JSON-RPC 2.0 | 公共契约 |
| 分帧 | 一行一个 JSON（NDJSON） | stdio Adapter 契约 |
| Transport | stdio | v1 正式入口 |

协议版本从 `"1.0"` 开始，当前最新版本为 `"1.6"`，与 npm 包版本独立演进。未来扩展新的
Transport 时，无需改变 Thread、Turn 或事件的核心领域语义。

`RUNTIME_PROTOCOL_VERSION` 仅代表协议包内置的最新 wire schema 版本，并不意味着任意客户端天然具备该版本所需的入站处理能力。协议 `1.2–1.6` 保持 `initialize` 的严格入参结构不变，并在握手完成后通过
`client.capabilities.set` 显式声明当前客户端可处理的 Server Request 方法。`1.1` 与 `1.0` 客户端继续按原有契约逐级回退，严禁将 `1.2+` 的能力协商字段塞入旧版初始化握手中。

## Runtime → Client 双向 RPC

`"1.1"` 将 Approval 从“单向事件 + 客户端写方法”升级为由 Runtime 发起的类型化 Server Request；
`"1.2"` 起进一步将内部生命周期抽象为与具体方法解耦的通用 Interaction，并引入递增的客户端能力版本（capability revision）：

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

各层职责边界：

| 层 | 持有 | 不持有 |
|---|---|---|
| `RuntimeService` | Interaction 对应的领域权威状态、Turn 归属、最终决议与终态顺序 | JSON-RPC 请求/响应关联 |
| `RuntimeClientRequestCoordinator` | 当前进程内的逻辑 Interaction、单次投递 ID、响应方资格与作用域校验、取消、截止时间及进程内显式重投 | Tool 策略判定、持久化存储与跨进程恢复 |
| `RuntimeProtocolAdapter` | 连接级版本协商、类型化 wire 转换与向下兼容投影 | 跨连接存续的业务状态 |
| Client / GUI | 已完成 capability ACK 的临时交互界面 | Thread/Turn 权威状态、跨进程恢复与最终裁决状态 |

本地 Runtime `1.2–1.6` Interaction 链路中的四类标识各司其职，不得混用：

| ID | 生命周期 | 用途 |
|---|---|---|
| JSON-RPC `id` | 单次连接上的一次投递 | Server Request 与 Response 关联 |
| `interactionId` | 一次逻辑 Interaction | 进程内显式重投、取消通知（`1.2–1.6`）与迟到结果去重 |
| `approvalId` | Approval 领域对象 | Snapshot、审计账本与 Approval 视图展示；并非通用 Interaction ID |
| mutation `requestId` | Client → Runtime 写操作 | `turn.start` 等写操作的幂等去重键 |

`approvalId` 是领域业务对象 ID；接入远程 Relay 后还会引入 Relay 请求 ID 与投递序号，跨层完整对照见下文。

Coordinator 支持在当前进程内向具备资格的响应方执行显式重投：重投会分配新的 JSON-RPC `id`，但保持原
`interactionId` 不变，且绝不延长初始截止时间。stdio 宿主遵循“断线即取消”原则，不保留跨进程可恢复的 Server Request；跨网络的序列确认、响应方会话重连与重投由上层 Relay 协议负责。

当前 v1 stdio 宿主限制每个 `RuntimeService` 实例同一时刻仅允许绑定一个活动的
`RuntimeProtocolAdapter` 控制连接，从而避免多个本地 GUI 控制器争抢完成同一次审批。多窗口只读观察、控制权移交与跨连接重投需依托独立的响应方注册与 Relay 传输层，不能由单连接 Coordinator 自行外推。

每条连接在首次调用 `initialize`（或任意 Runtime Protocol 方法）与旧版 `session.*` 方法时即锁定所属协议族，同一连接内严禁混用两套协议。`roll chat` 终端 TUI 直接在进程内调用 `AgentSession` 并配合 `clack` 选择式确认，不经过上述 stdio Server Request 链路。

## 持久事件恢复与 Snapshot 收敛

协议 `1.3–1.6` 将事件显式划分为两类：

- **durable（持久事件）**：覆盖 Turn 生命周期状态、完整消息、脱敏 Tool 完成投影（`1.5+` 含 `appOutput` 描述符）、安全 Approval 状态、能力变更（`capabilities.changed`），以及 `1.6` 新增的上下文恢复门禁变更（`context.recovery.changed`）。Runtime 必须先将事件与 `cursor` 原子提交至 Thread 事件日志，随后才可发布实时通知；一旦底层存储写入失败，严禁向客户端发出无法持久恢复的 durable 事件。
- **ephemeral（临时事件）**：覆盖流式消息增量、推理摘要增量（`reasoning.summary.delta`）、`1.6` 本地推理文本订阅增量（`reasoning.text.delta`），以及工具启动与标准输出/错误增量。此类事件仅携带进程内单调递增的 `sequence`，不写入持久事件日志，也不参与重放。

`RuntimeEventEnvelope.sequence` 仅在当前 `runtimeInstanceId` 生命周期内单调递增；而 `1.3–1.6` durable event 额外拥有独立的 `eventId` 与按 Thread 排序的不透明 `cursor`。标准恢复流程为：客户端先暂存恢复期间并发到达的实时 durable event，随后调用 `runtime.events.resume({ threadId, afterCursor })`；Runtime 逐条下发重放通知，最后返回的 RPC 响应 `{ throughCursor, replayedCount }` 构成“重放→实时”切换屏障（barrier）。客户端必须在收到该响应屏障后，再按 `cursor` 排序、按 `eventId` 去重并释放暂存的实时事件。

事件重放走专用的无副作用下发通道，绝不会重新触发审批、用户输入、工具调用或 Turn 执行。每个 Thread 默认最多保留 `10,000` 条、`16 MiB` 或 `30` 天的持久事件，超限时仅连续裁剪最早的前缀；`afterCursor: null` 严格代表原始日志起点，若该起点已被裁剪则返回 `EVENT_CURSOR_EXPIRED`。凡遇到游标过期、日志缺口、`runtimeInstanceId` 变更或客户端检测到流缺口时，均须回退至 `thread.snapshot`（`1.3–1.6` 使用受字节上限保护的恢复投影读取最新 `eventCursor` 作为新检查点；`1.0–1.2` 继续直接读取普通 Snapshot）。

Snapshot 直接基于追加式 transcript 与 Tool 账本构建，不读取可能已被模型上下文压缩裁剪的活动消息列表，并同步恢复活动 Turn、安全 `pendingInteractions`、`1.6` `contextRecovery` 以及 UI 展示投影。执行结果未知的写操作在任何情况下均不得自动重放；若 Runtime 异常退出时尚有未终止的 Turn，UI 恢复后该 Turn 仍显示为 `outcome unknown`。

## 本地与远程信任边界

`RuntimeServer` 仅面向受信任的本地 Transport，本身不内置网络鉴权或多租户隔离，严禁直接暴露于公网。

远程 Web 接入采用独立的 Companion Relay Protocol：

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

远程链路划分为三个公开 npm 包与一个位于 Core 内部的官方宿主实现：

| 包 | 负责 | 不负责 |
|---|---|---|
| `@roll-agent/relay-protocol` | Relay Wire（`1.3` / `1.2` / `1.1` / `1.0`）、Browser Control `1.0`、方向白名单、ID Schema、JSON Schema、fixtures 与 TypeScript 类型 | 网络传输、账号体系、数据库、业务策略与服务部署 |
| `@roll-agent/relay-client` | Browser Session 握手、请求关联、Chat/Interaction 状态归约、ACK/缺口恢复、断线重连与 Snapshot 收敛 | 具体前端组件、第三方登录鉴权、Cloud Relay 管理接口与原始帧操作 API |
| `@roll-agent/companion` | 消费 Relay 契约；提供本机桥接、Workspace 租约、本地审批与 `appOutput` 策略、ACK/缺口帧缓冲、幂等去重与主动出站重连 | 定义独立 Wire Schema、生产级 Cloud Relay 服务端或浏览器端业务状态机 |
| `@roll-agent/core` 内部 Companion Host | `roll companion` 命令、系统级设备凭据存储、Workspace 绑定、Runtime 子进程守护、本机 IPC 与用户级后台服务 | 对外承诺稳定的第三方 Host SDK、Cloud Relay 服务端或第三方业务界面 |

各产品形态的依赖与启用边界如下：

| 产品组件 | 安装 | 激活方式 |
|---|---|---|
| Local-only Desktop | `@roll-agent/client-node`，按需加装 `@roll-agent/protocol` | 桌面应用主进程显式启动本地 stdio Runtime |
| Browser Web App | `@roll-agent/relay-client` | 第三方后端兑换短期票据，前端连接已认证的 Cloud Relay |
| Cloud Relay | `@roll-agent/relay-protocol` | 独立生产服务负责账号绑定、会话路由与帧转发 |
| Local Companion Host | 官方签名安装包 / `@roll-agent/core` 开发安装 | 执行 `roll companion enroll` 与 `service install`；后台服务仅建立主动出站 WSS |

`@roll-agent/companion` 是底层桥接库，普通第三方无需用它自行拼装桌面守护进程。官方守护进程内置于 Core 并统一通过 `roll companion` 管理，当前不单独发布面向第三方的 `companion-host` SDK。安装任何 npm 包均不会自动完成设备绑定或启动后台服务；运行 `roll chat`、纯本地 Electron 客户端或 `roll runtime serve --stdio` 也不会发起任何 Relay 网络连接。

`authentication.request` 与文件选择器（File Picker）没有远程投影器，始终保持仅限本地使用。Runtime `1.3–1.6` 的持久事件恢复仅重放既有安全事件投影，不会将此类本机敏感交互带入 Relay；未来若需支持远程调用，必须先通过专项安全架构评审。

Cloud Relay 与高级自定义传输层应直接使用 `@roll-agent/relay-protocol` 校验协议帧；普通 Web 前端只需依赖 `@roll-agent/relay-client`，不应为了校验帧结构而引入 `@roll-agent/companion`。

Relay Wire `1.1–1.3` 提供通用的 `interaction.request` / `interaction.resolved` / `interaction.cancelled` 与 `interaction.candidate`：其中 Wire `1.2` 新增按需读取工具结构化输出的 `operation.result.get` 及 `appOutput` 描述符，Wire `1.3` 新增 Snapshot `contextRecovery` 与 `context.recovery.changed` 事件投影；冻结的 Wire `1.0` 仅保留旧版 Approval 专属路径。Runtime `1.3–1.6` 的 `eventCursor` 不会被映射为 Relay ACK，新增的本地 Runtime 方法也不会在未升级 Relay 版本的情况下自动对远端暴露。

实时推送事件与主动拉取查询遵循同一套脱敏安全边界。在 Wire `1.1–1.3` 下，`thread.open` 与 `thread.snapshot` 必须按协商版本经过 `projectRelayThreadSnapshotV11()` / `projectRelayThreadSnapshotV12()` / `projectRelayThreadSnapshotV13()` 投影，`operation.get` 必须经过 `projectRelayOperationGetResultV11()` / `projectRelayOperationGetResultV12()` 投影；遇到畸形的 Runtime 返回值时投影器会立即抛错并按 fail-closed 拒绝。`CompanionRelayBridgeV11` 内置了上述按版本投影逻辑，并将各类内部异常统一收敛为稳定的错误码、`retryable` 标记与固定公开文案；高级自定义宿主在构造 `runtime.response` 前也必须执行同等投影，严禁将 Runtime 或本地策略的原始错误消息直接回传远端。冻结的 Wire `1.0` 不具备该远程脱敏保证，仅限处于同等本地信任边界内的旧版对端使用；面向 Cloud / Browser 接入时，若无法协商到 Wire `1.1` 及以上版本必须直接拒绝连接。

跨层接线必须严格区分以下关联、幂等与流控游标：

| 标识或游标 | 所属层 | 语义 |
|---|---|---|
| Runtime JSON-RPC `id` | Runtime ↔ Local Client/Companion | 当前本地连接上单次请求/响应的投递关联 |
| Runtime `interactionId` | Runtime typed Interaction | 当前进程内显式重投时保持稳定；不承诺跨进程 Server Request 恢复 |
| Relay `requestId` | Browser/Cloud Relay ↔ Companion | Relay 响应关联、断线重投、参数冲突检测与幂等结果缓存 |
| Runtime mutation `params.requestId` | Client/Companion → Runtime | `turn.start` 等 Runtime 写操作的幂等键 |
| Runtime `eventId` / `eventCursor` | 单 Thread durable event 日志 | 持久事件去重、重放与 Snapshot 检查点 |
| Relay `relaySequence` / ACK | 单 Workspace Relay 投递流 | 当前 Companion 进程内的安全投影帧排序、重投与确认 |

`RuntimeEventEnvelope.sequence` 仅在单个 `runtimeInstanceId` 内递增；Runtime `eventCursor` 按 Thread 标识持久事件日志位置；Relay `relaySequence` 与 ACK 仅描述单个 Workspace 安全投影流的投递进度。三者互不等价：Relay ACK 无法确认 Runtime `eventCursor`，Runtime 也不能用 Relay 序号续接持久事件；持久事件恢复机制不修改底层 Relay 帧确认模型，也不引入持久化的 Relay outbox。

`@roll-agent/companion` 当前提供的本机底层能力包括：

- Browser 客户端租约与后台 Shell 租约由完成鉴权的宿主显式获取和释放；
- 仅通过 `CompanionWorkspace.startTurn()` 发起的 Turn 自动持有运行租约；`CompanionInteractionBroker` 统一托管 Runtime `1.2–1.6` 的 Approval / User Input，并为 Runtime `"1.1"` Approval 提供兼容适配层，在返回结果、中止、超时或 Turn 终态时保证单次原子结算（已弃用的 `CompanionApprovalRequestBroker` 仅为旧版兼容保留）；
- 释放 Browser 租约不会关闭仍持有 Turn、后台 Shell 或未决 Interaction 租约的 Runtime；
- 单 Workspace 帧缓冲上限默认为 `10,000` 条或 `32 MiB`，超出窗口时下发 `runtime.gap` 通知前端回退读取 Snapshot；
- Relay 桥接器仅针对写操作的 `workspaceId + requestId` 维护有界响应缓存，并通过规范化 JSON 的 SHA-256 指纹校验参数一致性；执行中的请求不会被淘汰，已完成结果按 LRU 保留，只读查询不进入缓存以免驻留大体积 Snapshot；
- ACK 仅允许推进至当前连接周期（generation）已实际发出的最高连续序号；每次重连均创建独立发送队列，旧连接中挂起的发送或加解密任务不会阻塞新连接握手与帧重投；
- 参数完全一致的重复写操作直接复用缓存结果，相同 `requestId` 搭配不同方法或参数则返回冲突错误；本地 Runtime 自身的有界 `requestId` 与已完成 `turnId` 窗口构成第二道幂等防线；
- Relay Wire `1.1–1.3` 的浏览器交互响应统一通过 `interaction.candidate` 提交；冻结的 Wire `"1.0"` 仅在受信本地兼容场景下保留旧版审批路径（Runtime `"1.1"` 走 `approval.candidate`，Runtime `"1.0"` 走 `approval.respond`）。提交候选成功仅返回 `{ accepted: true }`，权威终态仍由有序事件流给出。外层 Wire `"1.0"` 绝不能承载 Runtime `1.2–1.6` 的新增字段；
- 远端提交的 `approve` 候选在落盘前仍需通过本地审批策略校验（返回 `require-local-confirmation` 时抛出 `LocalConfirmationRequiredError`，不会自动创建弹窗），而远端 `reject` 仅收窄权限可直接生效；Wire `1.2–1.3` 的 `operation.result.get` 还受 `CompanionWorkspace` 的 `remoteAppOutputPolicy` 动态门禁约束；
- 绑定了 payload cipher 的 Workspace 仅接受 `runtime.encrypted` 请求；明文请求在触达 Runtime 前即以 `RELAY_ENCRYPTION_REQUIRED`（`retryable: false`）拒绝，所有响应、事件与交互帧也一律封装为加密信封。

Wire `1.1–1.3` 宿主还必须为每次连接注入 `requestPolicy`。桥接器会在查询幂等缓存与转发至 Runtime 之前对每条 `runtime.request` 执行该策略；被拒绝的请求统一返回固定错误码 `REMOTE_REQUEST_DENIED`。官方 `roll companion` 默认协商 Wire `"1.2"`（可选 `"1.3"`），仅放行已绑定 Workspace 的 `thread.list`、`thread.create`、`thread.open`、`thread.snapshot`、`thread.capabilities`、`turn.start`、`turn.cancel`、`operation.get`、`operation.result.get` 与 `interaction.candidate` 共 10 个方法。

上述 Relay 帧缓冲、ACK 进度、幂等缓存与租约均为 Companion 进程内存态，并非持久化队列。Companion 进程重启后，宿主必须重新建立连接与租约；本地 Runtime 协商到 `1.3–1.6` 时可通过 durable event replay 恢复事件，否则通过 `thread.snapshot` 收敛界面。

官方生产 Cloud Relay 已部署于 `sponge-mcp.duliday.com`；独立的 `roll-cloud-relay` 服务在协议包之外负责实现：

- Cloud Relay 服务端接入、账号与设备绑定存储、应用鉴权及 Workspace 路由；
- TLS 卸载、短期 Browser Session 签发与校验、设备长期绑定管理、心跳保活、帧大小限制、限流、高可用、监控与协议诊断；
- 将已认证的 Browser 连接生命周期映射至 `attachBrowser()` / `detachBrowser()` 的可信控制面；
- 后台 Shell 租约生命周期管理；
- 端到端加密 cipher 的算法选型、AEAD、nonce 管理、密钥协商/轮换、浏览器端实现与密钥托管。

官方 P0 Companion 不启用电脑端二次弹窗确认：本机 Runtime 配置的 `auto` / `confirm` / `deny` 是唯一审批事实源，已认证的 Web 端只能完成 Runtime 生成的 `confirm` 交互，无法越过 `deny`。底层 `@roll-agent/companion` 仍保留可进一步收窄权限的 `localApprovalPolicy` 接口供自定义宿主扩展。

即使启用了 payload cipher，Cloud Relay 仍需读取 `workspaceId`、`payloadKind`、`requestId` 或 `relaySequence` 等外层路由元数据。底层消息格式、缓存与关闭语义详见
[`@roll-agent/relay-protocol` Relay v1 参考](./companion-relay-v1-reference.md)。

面向公网的多租户云端 Roll 部署必须按租户或 Workspace 分配独立隔离的 Worker，严禁多个不可信租户共享同一个 Roll 进程、工作目录、环境变量或 Shell。

## v1 明确不覆盖

- 通用持久 Artifact 文件生命周期管理（注：Protocol `1.5+` 已通过 `operation.result.get` 提供单条 `256 KiB` 以内的有界结构化 `app-output` 按需读取）；
- 多步骤 Workflow DAG 编排；
- 细粒度自定义权限 DSL；
- stdio 之外的内置本地 Runtime Transport；
- Runtime 进程崩溃后的未完成动作自动续跑；
- 本仓库内的生产 Cloud Relay 服务端实现、跨节点高可用（HA）或持久化 Browser outbox；
- Runtime Server Request 的跨进程持久化重投、持久化 Relay outbox 与跨进程响应方会话恢复。

上述能力未来均可在不破坏 v1 核心领域对象的前提下渐进扩展。
