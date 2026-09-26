# @roll-agent/relay-client

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @roll-agent/relay-protocol@0.4.1

## 0.2.0

### Minor Changes

- [#273](https://github.com/steveoon/roll-agent/pull/273) [`25048bf`](https://github.com/steveoon/roll-agent/commit/25048bfe7568c0588a1ea93fda595cd2e9aaf716) Thanks [@steveoon](https://github.com/steveoon)! - Add opt-in structured App results so third-party clients can render their own UI from Subagent data.
  - Publish portable output contracts through MCP and store complete, validated results independently of lossy model/display projections.
  - Add Runtime Protocol 1.5 and Relay Wire 1.2 result queries, lightweight operation descriptors, and typed Node/Relay client APIs while preserving older wire projections.
  - Require both producer opt-in and an exact, live host tool grant for remote reads; avoid caching completed result responses across authorization changes.
  - Preserve completed execution in `roll run` and `roll ask` when an opted-in tool reports invalid or oversized App output, exposing `appOutputStatus` without automatically repeating the operation.
  - Distinguish credential-content rejection (`rejected`, with safe diagnostics) from access denial (`denied`), preserve ordinary business fields, and isolate invalid Roll output declarations from healthy tools.
  - Keep result reads free of retention writes and preserve original expiry across history recovery and forks.

### Patch Changes

- Updated dependencies [[`25048bf`](https://github.com/steveoon/roll-agent/commit/25048bfe7568c0588a1ea93fda595cd2e9aaf716)]:
  - @roll-agent/relay-protocol@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies []:
  - @roll-agent/relay-protocol@0.3.3

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - @roll-agent/relay-protocol@0.3.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @roll-agent/relay-protocol@0.3.1

## 0.1.0

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

- Updated dependencies [[`4393302`](https://github.com/steveoon/roll-agent/commit/4393302ed4407ee5abeff7f23e57066d0ac146b6)]:
  - @roll-agent/relay-protocol@0.3.0
