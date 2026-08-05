# @roll-agent/companion

## 0.3.0

### Minor Changes

- [#200](https://github.com/steveoon/roll-agent/pull/200) [`a86c3f7`](https://github.com/steveoon/roll-agent/commit/a86c3f7f6cf433e3f8a5a32116547a8e7245d770) Thanks [@steveoon](https://github.com/steveoon)! - Add the Relay Wire 1.1 Companion interaction broker, safe remote projections, generation-scoped
  candidate policy, and an explicitly non-production in-memory testing transport.

### Patch Changes

- [#201](https://github.com/steveoon/roll-agent/pull/201) [`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d) Thanks [@steveoon](https://github.com/steveoon)! - Add Runtime Protocol 1.3 durable event cursors, bounded per-Thread replay storage, a
  replay-to-live response barrier, and a Node client recovery manager with Snapshot fallback.

- [#196](https://github.com/steveoon/roll-agent/pull/196) [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733) Thanks [@steveoon](https://github.com/steveoon)! - Negotiate Runtime Protocol 1.2 Server Request capabilities before delivery, carry branded
  Interaction metadata on Approval requests, cancel 1.2 requests by InteractionId, and keep the
  Protocol 1.1 and 1.0 control paths wire-compatible.
  Freeze Relay Wire 1.0 against Runtime 1.2 schema drift and project newer Runtime snapshots and
  events to its existing Runtime 1.1-compatible envelope before remote delivery.

- [#204](https://github.com/steveoon/roll-agent/pull/204) [`90afb81`](https://github.com/steveoon/roll-agent/commit/90afb819604dd718a59e5d0065b80f6a9b8ded23) Thanks [@steveoon](https://github.com/steveoon)! - Add explicit Relay Wire 1.1 query projectors for snapshots and operations, apply them in the
  Companion bridge, and prevent Runtime or local policy error details from crossing the Relay wire.
- Updated dependencies [[`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d), [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a), [`cc19da9`](https://github.com/steveoon/roll-agent/commit/cc19da92533320cf4ebff9ba665001f1194f2776), [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733), [`e17ca19`](https://github.com/steveoon/roll-agent/commit/e17ca19259e5b8a263aa99bfa0979e475ab3c00d), [`90afb81`](https://github.com/steveoon/roll-agent/commit/90afb819604dd718a59e5d0065b80f6a9b8ded23), [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a), [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733)]:
  - @roll-agent/protocol@0.4.0
  - @roll-agent/client-node@0.3.0
  - @roll-agent/relay-protocol@0.2.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd)]:
  - @roll-agent/protocol@0.3.0
  - @roll-agent/client-node@0.2.1
  - @roll-agent/relay-protocol@0.1.1

## 0.2.0

### Minor Changes

- [#191](https://github.com/steveoon/roll-agent/pull/191) [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494) Thanks [@steveoon](https://github.com/steveoon)! - Add Runtime Protocol 1.1 bidirectional approval requests, expose them through the
  `roll runtime serve --stdio` CLI, and provide typed Node handlers, connection-scoped
  correlation, AbortSignal cancellation, authoritative terminal approval events,
  Companion candidate brokering, observer/transport fail-closed boundaries, and a compatible
  Protocol 1.0 fallback.

- [#191](https://github.com/steveoon/roll-agent/pull/191) [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494) Thanks [@steveoon](https://github.com/steveoon)! - Extract the versioned, Browser-safe Relay Protocol and conformance suite into a
  standalone package while keeping Companion compatibility exports. Make replay
  classification request-identity aware, expose exact method dispositions to
  cross-language consumers, and fail a Relay transport generation on ordered-send
  errors so events and cached mutation responses recover without duplicate Runtime
  execution or ACK gaps.

### Patch Changes

- Updated dependencies [[`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494), [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494)]:
  - @roll-agent/protocol@0.2.0
  - @roll-agent/client-node@0.2.0
  - @roll-agent/relay-protocol@0.1.0

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
  - @roll-agent/client-node@0.1.0
