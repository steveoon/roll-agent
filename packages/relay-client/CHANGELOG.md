# @roll-agent/relay-client

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
