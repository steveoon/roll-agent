# Roll Runtime Protocol 的架构与边界

## 结论

第三方 UI 的稳定接入边界是版本化 `Roll Runtime Protocol`；`ConversationEngine`
仍是内部执行引擎，stdio 只是首个本地 Transport。

```text
Electron / Tauri / Qt / Python / IDE / Gateway
                    │
          Roll Runtime Protocol v1
                    │
        JSON-RPC + NDJSON + stdio
                    │
              RuntimeService
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

协议版本从 `"1.0"` 开始，与 npm 包版本独立。未来增加 Transport 时，不需要改变
Thread、Turn 或事件语义。

## 状态恢复而非持久事件重放

`runtime.event` Notification 的 `params.sequence`（即
`RuntimeEventEnvelope.sequence`）只在当前 `runtimeInstanceId` 内单调递增。Runtime
重启后：

1. 客户端发现新的 `runtimeInstanceId`；
2. 不自动重放结果未知的副作用命令；
3. 调用 `thread.snapshot` 恢复 transcript、Operation、活动 Turn 和待审批状态；
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

`@roll-agent/companion` 当前实现的本地基础能力：

- Browser client 与后台 Shell lease 由认证宿主手动接线；
- 只有经 `CompanionWorkspace.startTurn()` 发起的 Turn 自动持有 lease，Approval lease 由
  `approval.required` 与响应/终态事件自动维护；
- Browser lease 释放不会关闭仍有 Turn、Shell 或 Approval lease 的 Runtime；
- 最多缓冲 `10,000` 个事件或 `16 MiB`，溢出时返回 gap 并要求 Snapshot；
- Relay bridge 只对 mutation 的 `workspaceId + requestId` 做有界响应缓存，并以
  SHA-256 指纹校验参数；活动请求不淘汰，已完成结果按 LRU 保留，读取请求不缓存大型
  Snapshot；
- ACK 只能推进到当前连接已成功发送的最高事件序号；每次重连使用独立发送队列，旧连接
  中阻塞的发送或加密任务不会阻塞新连接握手与事件恢复；
- 完全重复投递复用原 mutation 结果，相同 ID 配不同参数会被拒绝；Runtime 仍以协商得到
  的有界 `requestId` 与已完成 `turnId` 窗口作为第二道幂等边界；
- 远程批准仍经过本地 Policy；`require-local-confirmation` 会返回
  `LocalConfirmationRequiredError`，不会自行创建确认 UI；
- cipher-bound Workspace 只接受 `runtime.encrypted` 请求；明文请求在触达 Runtime 前以
  `RELAY_ENCRYPTION_REQUIRED`、`retryable: false` 拒绝，response/event 也只发送加密信封。

上述事件缓冲、ACK、sequence、幂等缓存和 lease 都是 Companion 进程内状态，不是持久
队列。Companion 重启后，宿主必须重建连接与 lease，并使用 `thread.snapshot` 收敛 UI。

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
[`@roll-agent/companion` Relay v1 参考](./companion-relay-v1-reference.md)。

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
- 生产 Cloud Relay、Browser SDK 或 Companion 状态持久化。

这些能力可以在不破坏 v1 基础对象的前提下逐步扩展。
