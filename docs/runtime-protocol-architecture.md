# Roll Runtime Protocol 的架构与边界

## 结论

第三方 UI 的稳定接入边界是版本化 `Roll Runtime Protocol`；`ConversationEngine`
仍是内部执行引擎，stdio 只是首个本地 Transport。

```text
Electron / Tauri / Qt / Python / IDE / Gateway
          │ Request / Notification / Response
          ▼
 Roll Runtime Protocol v1.2
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

协议版本从 `"1.0"` 开始，当前最新版本为 `"1.2"`，与 npm 包版本独立。未来增加
Transport 时，不需要改变 Thread、Turn 或事件语义。

`RUNTIME_PROTOCOL_VERSION` 只表示协议包中的最新 wire schema，不代表每个 Client 自动拥有
该版本的入站能力。1.2 保持 `initialize` 的 strict 形状，并在协商完成后通过
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

本地 Runtime 1.2 Interaction 链路中的身份不能混用：

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

## 状态恢复而非持久事件重放

`runtime.event` Notification 的 `params.sequence`（即
`RuntimeEventEnvelope.sequence`）只在当前 `runtimeInstanceId` 内单调递增。Runtime
重启后：

1. 客户端发现新的 `runtimeInstanceId`；
2. 不自动重放结果未知的副作用命令；
3. 调用 `thread.snapshot` 恢复 transcript、Operation、活动 Turn、待审批 View，以及 1.2
   当前 responder 已 ACK 的安全 `pendingInteractions` 投影；
4. 对 Runtime 崩溃时仍未终止的 Turn 显示 `outcome unknown`。

Snapshot 从追加式 transcript 与 Tool ledger 构造，不读取可能已被上下文压缩的活动模型消息。

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

远程层分成两个独立 package 边界：

| 包 | 负责 | 不负责 |
|---|---|---|
| `@roll-agent/relay-protocol` | Relay Wire version、显式冻结的消息/方法注册表、ID Schema、JSON Schema、fixtures、TypeScript types | Transport、账号、数据库、Policy、部署 |
| `@roll-agent/companion` | 消费 Relay 契约；提供本机 bridge、Workspace lease、本地 Policy、ACK/gap 缓冲、去重与出站重连 | 定义第二套 Wire Schema、生产 Cloud Relay、Browser 业务状态机 |

对应的安装与激活边界是：

| 产品组件 | 安装 | 激活方式 |
|---|---|---|
| Local-only Desktop | `@roll-agent/client-node`，按需加 `@roll-agent/protocol` | Desktop Main 显式启动本地 stdio Runtime |
| Browser Web App | `@roll-agent/relay-protocol` | 连接经过认证的 Cloud Relay |
| Cloud Relay | `@roll-agent/relay-protocol` | 生产服务负责账号、路由与可靠投递 |
| Local Companion Host | `@roll-agent/companion`、`@roll-agent/client-node`、`@roll-agent/relay-protocol` | 用户显式启用远程访问后启动 Outbound Relay 或绑定 Transport |

`@roll-agent/companion` 是用户本机 Host 库，不是 Cloud 服务或自动运行的 daemon。
`npm install -g @roll-agent/core` 不会安装/启动它；普通 `roll chat`、Local-only Electron
和 `roll runtime serve --stdio` 也不会创建 Relay 连接。

Browser、Cloud Relay 与 Local Companion 都应直接以 `@roll-agent/relay-protocol` 校验 Wire
frame；不能为了获得 Schema 而依赖整个 `@roll-agent/companion`。

当前只冻结 Relay Wire `"1.0"`。其中 `approval.candidate` 是已经存在的 Approval 专属
候选方法，不是通用 typed interaction。Runtime Protocol `"1.2"` 已拥有逻辑
`interactionId`，但通用 request/resolved/cancelled 的远程投影仍由
[#187](https://github.com/steveoon/roll-agent/issues/187) 的后续 Relay Wire version
承载，不能静默扩大 `"1.0"` 注册表。

跨层接线必须区分以下五类 correlation、幂等与投递标识：

| 标识或游标 | 所属层 | 语义 |
|---|---|---|
| Runtime JSON-RPC `id` | Runtime ↔ Local Client/Companion | 当前本地连接上的一次 Request/Response 投递 |
| Runtime `interactionId` | Runtime typed Interaction | 当前进程内显式重投保持稳定；Relay `"1.0"` 尚未定义，也不提供跨进程恢复 |
| Relay `requestId` | Browser/Cloud Relay ↔ Companion | Relay response correlation、重投、冲突检测与响应缓存 |
| Runtime mutation `params.requestId` | Client/Companion → Runtime | `turn.start` 等 Runtime 写操作幂等 |
| `sequence` / cursor | Runtime event 或 Relay delivery | 各自在自己的序列空间内排序和恢复 |

`RuntimeEventEnvelope.sequence` 只在当前 `runtimeInstanceId` 内递增；Relay
`relaySequence`/ACK cursor 只描述 Companion→Relay 的投递进度。两者即使数值相同也没有
等价关系：Relay ACK 不能确认 Runtime cursor，Runtime restart 后也不能用 Relay cursor
续接事件。`threadId`、`turnId`、`approvalId` 等业务对象 ID 不属于上述五类。

`@roll-agent/companion` 当前实现的本地基础能力：

- Browser client 与后台 Shell lease 由认证宿主手动接线；
- 只有经 `CompanionWorkspace.startTurn()` 发起的 Turn 自动持有 lease；Runtime
  `"1.2"` / `"1.1"` 的
  Approval lease 由 `CompanionApprovalRequestBroker` handler 获取并在 Result/Abort 时
  释放，`"1.0"` fallback 才由 Event 与响应/终态事件维护；
- Browser lease 释放不会关闭仍有 Turn、Shell 或 Approval lease 的 Runtime；
- 最多缓冲 `10,000` 个事件或 `16 MiB`，溢出时返回 gap 并要求 Snapshot；
- Relay bridge 只对 mutation 的 `workspaceId + requestId` 做有界响应缓存，并以
  SHA-256 指纹校验参数；活动请求不淘汰，已完成结果按 LRU 保留，读取请求不缓存大型
  Snapshot；
- ACK 只能推进到当前连接已成功发送的最高事件序号；每次重连使用独立发送队列，旧连接
  中阻塞的发送或加密任务不会阻塞新连接握手与事件恢复；
- 完全重复投递复用原 mutation 结果，相同 ID 配不同参数会被拒绝；Runtime 仍以协商得到
  的有界 `requestId` 与已完成 `turnId` 窗口作为第二道幂等边界；
- Runtime `"1.2"` / `"1.1"` 的 Browser 决策通过 Relay 专属
  `approval.candidate` 提交，成功只表示
  `{ accepted: true }`；Runtime 权威终态仍由 `approval.resolved` Event 给出，不能通过
  Relay 直接调用 `approval.respond`；
- Browser 必须按 Relay 事件内的 Runtime 兼容版本选择上述控制路径：本地 Runtime
  `"1.2"` 在 Relay Wire `"1.0"` 上投影为 `protocolVersion: "1.1"`，因此收到 `"1.1"`
  走 `approval.candidate`，收到 `"1.0"` 走 `approval.respond` fallback；外层 Companion
  Relay `"1.0"` 不代表 Runtime 审批能力，也不能承载 Runtime `"1.2"` 新字段；
- 远程 approve 候选仍经过本地 Policy；`require-local-confirmation` 会返回
  `LocalConfirmationRequiredError`，不会自行创建确认 UI；远程拒绝只会收窄权限，可直接
  返回拒绝；
- cipher-bound Workspace 只接受 `runtime.encrypted` 请求；明文请求在触达 Runtime 前以
  `RELAY_ENCRYPTION_REQUIRED`、`retryable: false` 拒绝，response/event 也只发送加密信封。

上述事件缓冲、ACK、sequence、幂等缓存和 lease 都是 Companion 进程内状态，不是持久
队列。Companion 重启后，宿主必须重建连接与 lease，并使用 `thread.snapshot` 收敛 UI。
这里的 ACK 只推进 Relay `relaySequence`，不会确认 Runtime event cursor。

生产宿主必须另外实现：

- Cloud Relay Server、账号/设备绑定存储、鉴权授权与 Workspace 路由；
- TLS、Browser SDK、持久配对、心跳、帧上限、HA、监控和协议诊断；
- Browser 连接身份到 `attachBrowser()` / `detachBrowser()` 的可信控制面；
- Shell lease 生命周期；
- 本机确认 UI 与只针对单次 Approval 的确认状态；
- cipher 的算法、AEAD、nonce、密钥协商/轮换、Browser 实现和密钥存储。

即使启用 payload cipher，Relay 仍可读取 Workspace ID、payload kind、request ID 或
sequence 等路由元数据。`@roll-agent/companion` 不包含生产 Cloud Relay 服务；其精确消息、
缓存与关闭语义见
[`@roll-agent/relay-protocol` Relay v1 参考](./companion-relay-v1-reference.md)。

公网多租户云端 Roll 必须按租户或 Workspace 使用独立 Worker。多个不可信租户不能共享一个
Roll 进程、工作目录、环境变量或 Shell。

## v1 明确不覆盖

- 持久事件重放；
- 附件和二进制传输；
- Artifact 生命周期；
- Workflow DAG；
- 权限 DSL；
- stdio 之外的 Runtime Transport；
- Runtime 崩溃后的自动执行恢复；
- 生产 Cloud Relay、Browser SDK 或 Companion 状态持久化；
- Runtime Server Request 的持久重投、Relay `seq/ack/resume` 与跨进程 responder 恢复。

这些能力可以在不破坏 v1 基础对象的前提下逐步扩展。
