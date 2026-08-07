# @roll-agent/relay-protocol

## 0.3.0

### Minor Changes

- [#209](https://github.com/steveoon/roll-agent/pull/209) [`4393302`](https://github.com/steveoon/roll-agent/commit/4393302ed4407ee5abeff7f23e57066d0ac146b6) Thanks [@steveoon](https://github.com/steveoon)! - 新增官方 `roll companion` 本机服务入口，由它管理受信官方 Relay、设备凭据、单一
  Workspace 和 `roll runtime serve --stdio` 子进程；远程请求在缓存与 Runtime dispatch
  之前统一经过 Host 提供的 allowlist policy。`roll ui` 配置台同步新增「Companion 管理」
  板块：状态审查、设备绑定、启停与服务安装、环境体检和实时日志都可以在浏览器里完成，
  不再要求使用 CLI。

  官方 Relay 的域名尚未最终确定，本版本将 `OFFICIAL_RELAY_PROFILE.host` 显式置为
  `null` 并整体 fail-closed：enroll 与出站连接会立刻返回「端点尚未确定」的明确错误
  （不发起任何网络请求、不消耗配对码），daemon 干净退出，`roll companion doctor` 新增
  `relay-endpoint` 检查项报告此状态。域名确定后由后续版本填入，仍不开放用户配置。

  发布 Browser-safe `@roll-agent/relay-client`，封装 Browser session、Relay request
  correlation、Chat/Interaction 状态、ACK/gap、重连与 Snapshot 收敛；普通 Web App 不再需要
  直接处理 raw Relay frame。

  在 `@roll-agent/relay-protocol/control` 增加 Browser Control 1.0、session descriptor、
  方向 allowlist、JSON Schema 与 fixtures，同时保持 Relay Wire 1.1 数据面 union 不变。
  `@roll-agent/companion` 的 Wire 1.1 connection options 现在必须显式提供全请求
  `requestPolicy`；拒绝统一返回不泄漏本机原因的 `REMOTE_REQUEST_DENIED`。

### Patch Changes

- Updated dependencies [[`da6bf86`](https://github.com/steveoon/roll-agent/commit/da6bf862b208ca4bf04a0d8e4c274bfe51b3b37c)]:
  - @roll-agent/protocol@0.4.1

## 0.2.0

### Minor Changes

- [#199](https://github.com/steveoon/roll-agent/pull/199) [`cc19da9`](https://github.com/steveoon/roll-agent/commit/cc19da92533320cf4ebff9ba665001f1194f2776) Thanks [@steveoon](https://github.com/steveoon)! - Add the explicitly versioned Relay Wire 1.1 interaction contract, safe Browser reference adapter,
  JSON Schema, fixtures, and N/N-1 conformance while keeping every legacy Wire 1.0 API and fixture
  frozen.

- [#204](https://github.com/steveoon/roll-agent/pull/204) [`90afb81`](https://github.com/steveoon/roll-agent/commit/90afb819604dd718a59e5d0065b80f6a9b8ded23) Thanks [@steveoon](https://github.com/steveoon)! - Add explicit Relay Wire 1.1 query projectors for snapshots and operations, apply them in the
  Companion bridge, and prevent Runtime or local policy error details from crossing the Relay wire.

### Patch Changes

- [#196](https://github.com/steveoon/roll-agent/pull/196) [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733) Thanks [@steveoon](https://github.com/steveoon)! - Negotiate Runtime Protocol 1.2 Server Request capabilities before delivery, carry branded
  Interaction metadata on Approval requests, cancel 1.2 requests by InteractionId, and keep the
  Protocol 1.1 and 1.0 control paths wire-compatible.
  Freeze Relay Wire 1.0 against Runtime 1.2 schema drift and project newer Runtime snapshots and
  events to its existing Runtime 1.1-compatible envelope before remote delivery.
- Updated dependencies [[`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d), [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a), [`e17ca19`](https://github.com/steveoon/roll-agent/commit/e17ca19259e5b8a263aa99bfa0979e475ab3c00d), [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733)]:
  - @roll-agent/protocol@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd)]:
  - @roll-agent/protocol@0.3.0

## 0.1.0

### Minor Changes

- [#191](https://github.com/steveoon/roll-agent/pull/191) [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494) Thanks [@steveoon](https://github.com/steveoon)! - Extract the versioned, Browser-safe Relay Protocol and conformance suite into a
  standalone package while keeping Companion compatibility exports. Make replay
  classification request-identity aware, expose exact method dispositions to
  cross-language consumers, and fail a Relay transport generation on ordered-send
  errors so events and cached mutation responses recover without duplicate Runtime
  execution or ACK gaps.

### Patch Changes

- Updated dependencies [[`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494)]:
  - @roll-agent/protocol@0.2.0
