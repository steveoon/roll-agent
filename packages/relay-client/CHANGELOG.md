# @roll-agent/relay-client

## 0.4.0

### Minor Changes

- [#329](https://github.com/steveoon/roll-agent/pull/329) [`e71025f`](https://github.com/steveoon/roll-agent/commit/e71025f902a7b708835639255c87ddd9f60459f7) Thanks [@steveoon](https://github.com/steveoon)! - 支持在聊天会话内调整推理强度。`gpt-5-pro` 仅支持 `high`。用它启动且省略推理强度，或在会话中切到它并使用默认档位时，Roll 会自动选择 `high`。其他会话继续沿用各自的设置。
  
  - **Runtime Protocol 1.7 与 `@roll-agent/client-node`**：扩展 `runtime.models.list`、`thread.model.get` 与 `thread.model.set`（不新增额外事件通道），承载 `active` / `target` 会话推理强度状态、四态能力描述（`levels` / `toggle` / `fixed` / `unknown`）、`isThreadEffortToggleEnabled()` 及 `THREAD_MODEL_FAILURES_V17` 中的 `"effort-unsupported"` 失败原因（向 `1.6` 投影为 `"config-changed"`）；发布的 1.7 JSON Schema 严格拦截重复 `levels`、相同 `offLevel`/`onLevel` 及空 `thread.model.set` 请求，并对 `1.6` 客户端保持严格投影与本地写拦截兼容。
  - **Core 模型能力表与 Runtime 切档状态机**：按已支持的模型系列正向解析公共推理强度能力（未知自定义模型返回 `unknown`，`gemini-2.5-pro` 不公告公共 `off`，OpenAI Pro 系列 `gpt-5-pro` / `gpt-5.2-pro` / `gpt-5.4-pro` / `gpt-5.5-pro` 及有效日期别名取 Core 实际可发送档位交集并在请求前拒绝低档与 `off`）；保持旧版 `1.6` `ThreadModelHost` 类型与运行时兼容并在握手时如实降级协商至 `"1.6"`；同模型切档保留宿主 `prepareEffort` 的 `this` 绑定并走轻量 `providerOptions` 热更新路径，保留已初始化的自动压缩配置与请求预算校准状态；跨模型切换（含 `effort: { mode: "default" }` 继承档位）在接纳前完成原子校验，非法组合不消耗 `revision`、不覆盖已有合法 `pending`，并发双写取代时返回请求自身 `revision` 的受理快照。
  - **Relay Wire 1.4、Companion 与 `@roll-agent/relay-client`**：新增受限远端方法 `thread.effort.get`（query）与 `thread.effort.set`（mutation）（不暴露本地模型目录、`selection` 与 `contextWindow`，`active.provider`/`active.model` 长度上限与 Runtime 身份保持 128/512 对齐），在 `RELAY_ERROR_CODES_V14` 中新增窄公开错误码 `THREAD_EFFORT_STATE_STALE`（`retryable: true`）与 `THREAD_EFFORT_UNSUPPORTED`（`retryable: false`）；`roll companion enroll`、`roll companion enable`、`roll companion run` 新增 `--relay-protocol-version <1.2|1.3|1.4>` 与 `ROLL_COMPANION_RELAY_PROTOCOL_VERSION` 入口，默认保持 `"1.2"` 兼容旧版 Relay；`@roll-agent/relay-client` 在 `RelayThread` 上新增 `getEffort()` / `setEffort()` 并导出 `RELAY_ERROR_CODES_V14` 与 `isThreadEffortToggleEnabled()`，同时在初连与重连握手阶段严格校验对端返回的 `session.ready.relayProtocolVersion` 属于本次实际 offer 列表。

### Patch Changes

- Updated dependencies [[`e71025f`](https://github.com/steveoon/roll-agent/commit/e71025f902a7b708835639255c87ddd9f60459f7)]:
  - @roll-agent/relay-protocol@0.6.0

## 0.3.4

### Patch Changes

- Updated dependencies []:
  - @roll-agent/relay-protocol@0.5.4

## 0.3.3

### Patch Changes

- Updated dependencies []:
  - @roll-agent/relay-protocol@0.5.3

## 0.3.2

### Patch Changes

- Updated dependencies [[`a88b359`](https://github.com/steveoon/roll-agent/commit/a88b359523475d223514e913b7c2f43562eee1e0)]:
  - @roll-agent/relay-protocol@0.5.2

## 0.3.1

### Patch Changes

- [#293](https://github.com/steveoon/roll-agent/pull/293) [`635a993`](https://github.com/steveoon/roll-agent/commit/635a993221f4e5364d278676754b388f09209486) Thanks [@steveoon](https://github.com/steveoon)! - Upgrade Zod to 4.6.6 to address oversized-array validation denial of service
  (GHSA-mrhx-c7xc-m3w5). SDK tool schemas and the exported Core, Runtime, Browser,
  Companion, and Reply Authority Client schemas now use Zod 4; TypeScript consumers using
  Zod 3 must migrate their schema definitions and composition. See
  `docs/how-to-migrate-zod4.md` for the required changes.
  
  Preserve nested configuration defaults, YAML key mapping, configuration UI
  constraints, tool preprocessing/refinements, and application-output validation.
  Runtime and Relay wire versions and payload formats remain unchanged; Protocol
  1.6 envelopes retain strict validation and capability checks with Zod 4.6.
  Protocol now exports `uuidSchema` so Relay can share the frozen UUID validation;
  existing UUID and timestamp acceptance and Relay schema fingerprints are preserved.
  Standalone installer builds resolve subpath manifests to the owning package so
  that the bundled Zod license is included correctly.
- Updated dependencies [[`635a993`](https://github.com/steveoon/roll-agent/commit/635a993221f4e5364d278676754b388f09209486)]:
  - @roll-agent/relay-protocol@0.5.1

## 0.3.0

### Minor Changes

- [#288](https://github.com/steveoon/roll-agent/pull/288) [`e029235`](https://github.com/steveoon/roll-agent/commit/e029235d500347477bf9214310106cf1ab7c0c5a) Thanks [@steveoon](https://github.com/steveoon)! - Preserve bounded legacy context recovery event transport through opt-in Relay Wire 1.3. New summary-based sessions have no active recovery gate. Companion continues to use Wire 1.2 by default, and the browser Relay Client continues to advertise Wire 1.2 and 1.1 by default. Enable Wire 1.3 explicitly only after the Relay service, Companion and browser client all support it; upgrading Roll alone does not enable Wire 1.3.
  
  Keep remote App-result queries and capability reporting available when Companion negotiates Runtime 1.6, with the existing producer and host permission checks. Runtime Protocol and Relay Wire versions remain independent: the updated Companion projects Runtime 1.6 data to the existing Wire 1.2 contract without requiring a Relay 1.3 rollout.
  
  Upgrade and restart the official Companion together with its bundled Runtime. The official host requires the bundled Runtime to negotiate its matching protocol version; mixing releases is not supported, even though ordinary Runtime clients retain older-version negotiation.

### Patch Changes

- Updated dependencies [[`e029235`](https://github.com/steveoon/roll-agent/commit/e029235d500347477bf9214310106cf1ab7c0c5a)]:
  - @roll-agent/relay-protocol@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`1f7fcab`](https://github.com/steveoon/roll-agent/commit/1f7fcaba153c5be60519d8d1afb0b08c5606bf88)]:
  - @roll-agent/relay-protocol@0.4.2

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
