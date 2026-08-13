# @roll-agent/client-node

## 0.4.0

### Minor Changes

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`38bb3c6`](https://github.com/steveoon/roll-agent/commit/38bb3c66dcd9090cf929b1eb6f85082839a2218f) Thanks [@steveoon](https://github.com/steveoon)! - Runtime Protocol 1.4：附件与二进制载荷引用（issue [#177](https://github.com/steveoon/roll-agent/issues/177)）
  - **protocol**：新增协议版本 1.4。`AttachmentDescriptor`（ID/文件名/安全展示名/MIME/字节数/sha256/来源）、`attachment.stage|chunk|commit|release` 四方法与 staging→committed→release 生命周期；`turn.start` 的 input 扩展 `attachments` 引用数组（纯附件可空文本）；八个稳定错误码（NOT_FOUND/NOT_COMMITTED/TOO_LARGE/TYPE_UNSUPPORTED/HASH_MISMATCH/QUOTA_EXCEEDED/UPLOAD_INCOMPLETE/PATH_REJECTED）；initialize limits 广播附件配额；`UiMessage` V14 新增 `attachment` 安全元数据 part，快照投影到 ≤1.3 时自动降级为 text-only；V13 及更早 schema 全部冻结不变，`turn.start` 携带 attachments 在 1.3 会话被 strict 拒绝
  - **runtime**：新增 `AttachmentStore`（staging 目录 + 内存状态机）：local-path 来源校验绝对路径/拒 symlink/大小与 sha256 匹配后一步 commit；chunks 来源按序追加（单 chunk ≤2MiB 原始字节，不突破 4MiB NDJSON 帧）、commit 时校验完整性与 hash，不匹配即回收；staged/committed 双 TTL 惰性回收、thread 删除联动清理、进程重启清扫孤儿文件；`RuntimeService` 注入 `attachmentStore` 后启用 attachments 能力，`turn.start` 解析附件引用为引擎 `SessionAttachment` 且客户端路径不落 thread；Thread Snapshot 返回附件安全元数据（mediaType/bytes），不含二进制与本地路径
  - **client-node**：协商版本联合扩展 1.4，事件重放与 recovery snapshot 在 1.4 会话可用；`request()` 通道从 Protocol 1.1 方法域升级到 latest 方法域——`attachment.stage|chunk|commit|release` 与带 `attachments` 的 `turn.start` 均可通过 `client.request(...)` 类型安全地调用（此前 V11 facade 会在类型层拒绝且 turnId 提取路径运行时崩溃）

### Patch Changes

- Updated dependencies [[`38bb3c6`](https://github.com/steveoon/roll-agent/commit/38bb3c66dcd9090cf929b1eb6f85082839a2218f)]:
  - @roll-agent/protocol@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`da6bf86`](https://github.com/steveoon/roll-agent/commit/da6bf862b208ca4bf04a0d8e4c274bfe51b3b37c)]:
  - @roll-agent/protocol@0.4.1

## 0.3.0

### Minor Changes

- [#201](https://github.com/steveoon/roll-agent/pull/201) [`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d) Thanks [@steveoon](https://github.com/steveoon)! - Add Runtime Protocol 1.3 durable event cursors, bounded per-Thread replay storage, a
  replay-to-live response barrier, and a Node client recovery manager with Snapshot fallback.

- [#196](https://github.com/steveoon/roll-agent/pull/196) [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733) Thanks [@steveoon](https://github.com/steveoon)! - Negotiate Runtime Protocol 1.2 Server Request capabilities before delivery, carry branded
  Interaction metadata on Approval requests, cancel 1.2 requests by InteractionId, and keep the
  Protocol 1.1 and 1.0 control paths wire-compatible.
  Freeze Relay Wire 1.0 against Runtime 1.2 schema drift and project newer Runtime snapshots and
  events to its existing Runtime 1.1-compatible envelope before remote delivery.

- [#197](https://github.com/steveoon/roll-agent/pull/197) [`e17ca19`](https://github.com/steveoon/roll-agent/commit/e17ca19259e5b8a263aa99bfa0979e475ab3c00d) Thanks [@steveoon](https://github.com/steveoon)! - Add the Runtime Protocol 1.2 `userInput.request` interaction, including five bounded control
  types, request-correlated result validation, safe pending projections, and a typed Node client
  handler. Expose the built-in `roll__user_input` Tool only after capability acknowledgement, wait
  in `waiting-for-user`, and settle cancellation, timeout, disconnect, or late responses exactly once.

### Patch Changes

- [#203](https://github.com/steveoon/roll-agent/pull/203) [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a) Thanks [@steveoon](https://github.com/steveoon)! - Accept Runtime capability ACKs that return the registry-ordered intersection of the requested
  Server Request methods, as the protocol contract specifies. The client previously demanded an
  element-and-order-exact echo and failed the connection on any legal subset, so a client-node
  newer than its Runtime could never negotiate. Unrequested methods and revision mismatches are
  still rejected, dropped methods answer -32601, and the redundant internal handler mirror map
  was folded into the single handler registry.
- Updated dependencies [[`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d), [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a), [`e17ca19`](https://github.com/steveoon/roll-agent/commit/e17ca19259e5b8a263aa99bfa0979e475ab3c00d), [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733)]:
  - @roll-agent/protocol@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd)]:
  - @roll-agent/protocol@0.3.0

## 0.2.0

### Minor Changes

- [#191](https://github.com/steveoon/roll-agent/pull/191) [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494) Thanks [@steveoon](https://github.com/steveoon)! - Add Runtime Protocol 1.1 bidirectional approval requests, expose them through the
  `roll runtime serve --stdio` CLI, and provide typed Node handlers, connection-scoped
  correlation, AbortSignal cancellation, authoritative terminal approval events,
  Companion candidate brokering, observer/transport fail-closed boundaries, and a compatible
  Protocol 1.0 fallback.

### Patch Changes

- Updated dependencies [[`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494)]:
  - @roll-agent/protocol@0.2.0

## 0.1.0

### Minor Changes

- [#182](https://github.com/steveoon/roll-agent/pull/182) [`705bde7`](https://github.com/steveoon/roll-agent/commit/705bde7f9d35450eff777073f6026907084864cf) Thanks [@steveoon](https://github.com/steveoon)! - 新增版本化 Roll Runtime Protocol v1、正式的 `roll runtime serve --stdio` 入口与
  `RuntimeService` 安全 UI 投影，同时保留旧 `roll chat --server` / `session.*` RPC。

  发布 Node 客户端与本地 Companion/Relay 基础包，支持显式工作区、流式事件、审批与取消、
  有界进程内幂等、Snapshot 恢复、事件 ACK/gap 缓冲、工作区生命周期 lease、出站 Relay 重连
  以及可插拔的敏感工作区端到端加密。cipher-bound Workspace 会拒绝明文请求并只发送加密
  response/event；算法、密钥管理、生产 Cloud Relay 与本机确认 UI 仍由宿主实现。

  Node 客户端会协商并暴露初始化结果，提供请求超时与 Runtime 退出订阅，并在畸形帧、非法
  事件或响应 DTO 不匹配时关闭连接、拒绝挂起请求；同时提供可等待、幂等的分阶段
  `shutdown()`；显式关闭或协议失败都会等待真实进程退出，并依次关闭 stdin、发送 SIGTERM、
  必要时 SIGKILL，避免 GUI 宿主退出后遗留 Runtime 或 Agent 子进程。连接结果不明确时会把
  活动 Turn 标记为 `outcome unknown`，交由 UI 通过 Snapshot 收敛且不自动重放副作用。

  Companion 与 Runtime 在各自公布的有界窗口内缓存并校验 mutation `requestId`，活动项不会
  被容量淘汰，大型读取响应不会进入缓存；Companion 还会限制 ACK 不能越过当前连接已发送的
  事件，并隔离每次重连的发送队列。Browser/Shell lease 由宿主手动接线，Turn/Approval lease
  自动维护；缓存、ACK、sequence 与 lease 均为进程内状态。重复投递不会重复执行副作用，
  同时保留稳定的 Runtime `rollCode` 与 Relay `code` / `retryable`。

### Patch Changes

- Updated dependencies [[`705bde7`](https://github.com/steveoon/roll-agent/commit/705bde7f9d35450eff777073f6026907084864cf)]:
  - @roll-agent/protocol@0.1.0
