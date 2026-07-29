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

`runtime.event.sequence` 只在当前 `runtimeInstanceId` 内单调递增。Runtime 重启后：

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

`@roll-agent/companion` 保证：

- 浏览器断线只释放浏览器 lease，不关闭活动 Turn、Shell Session 或待审批操作；
- 最多缓冲 `10,000` 个事件或 `16 MiB`，溢出时返回 gap 并要求 Snapshot；
- Relay bridge 只对 mutation 的 `workspaceId + requestId` 做有界响应缓存，并以
  SHA-256 指纹校验参数；活动请求不淘汰，已完成结果按 LRU 保留，读取请求不缓存大型
  Snapshot；
- ACK 只能推进到当前连接已成功发送的最高事件序号；每次重连使用独立发送队列，旧连接
  中阻塞的发送或加密任务不会阻塞新连接握手与事件恢复；
- 完全重复投递复用原 mutation 结果，相同 ID 配不同参数会被拒绝；Runtime 仍以协商得到
  的有界 `requestId` 与已完成 `turnId` 窗口作为第二道幂等边界；
- 远程批准仍经过本地 Policy，可要求本机确认；
- 敏感工作区可以注入 Browser 与 Companion 共享的 E2E cipher，Relay 只读取路由元数据。

公网多租户云端 Roll 必须按租户或 Workspace 使用独立 Worker。多个不可信租户不能共享一个
Roll 进程、工作目录、环境变量或 Shell。

## v1 明确不覆盖

- 持久事件重放；
- 附件和二进制传输；
- Artifact 生命周期；
- Workflow DAG；
- 权限 DSL；
- stdio 之外的 Runtime Transport；
- Runtime 崩溃后的自动执行恢复。

这些能力可以在不破坏 v1 基础对象的前提下逐步扩展。
