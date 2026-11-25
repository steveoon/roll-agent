---
"@roll-agent/protocol": minor
"@roll-agent/client-node": minor
"@roll-agent/runtime": minor
"@roll-agent/core": minor
"@roll-agent/relay-protocol": minor
"@roll-agent/companion": minor
"@roll-agent/relay-client": minor
---

支持在聊天会话内调整推理强度。`gpt-5-pro` 仅支持 `high`。用它启动且省略推理强度，或在会话中切到它并使用默认档位时，Roll 会自动选择 `high`。其他会话继续沿用各自的设置。

- **Runtime Protocol 1.7 与 `@roll-agent/client-node`**：扩展 `runtime.models.list`、`thread.model.get` 与 `thread.model.set`（不新增额外事件通道），承载 `active` / `target` 会话推理强度状态、四态能力描述（`levels` / `toggle` / `fixed` / `unknown`）、`isThreadEffortToggleEnabled()` 及 `THREAD_MODEL_FAILURES_V17` 中的 `"effort-unsupported"` 失败原因（向 `1.6` 投影为 `"config-changed"`）；发布的 1.7 JSON Schema 严格拦截重复 `levels`、相同 `offLevel`/`onLevel` 及空 `thread.model.set` 请求，并对 `1.6` 客户端保持严格投影与本地写拦截兼容。
- **Core 模型能力表与 Runtime 切档状态机**：按已支持的模型系列正向解析公共推理强度能力（未知自定义模型返回 `unknown`，`gemini-2.5-pro` 不公告公共 `off`，OpenAI Pro 系列 `gpt-5-pro` / `gpt-5.2-pro` / `gpt-5.4-pro` / `gpt-5.5-pro` 及有效日期别名取 Core 实际可发送档位交集并在请求前拒绝低档与 `off`）；保持旧版 `1.6` `ThreadModelHost` 类型与运行时兼容并在握手时如实降级协商至 `"1.6"`；同模型切档保留宿主 `prepareEffort` 的 `this` 绑定并走轻量 `providerOptions` 热更新路径，保留已初始化的自动压缩配置与请求预算校准状态；跨模型切换（含 `effort: { mode: "default" }` 继承档位）在接纳前完成原子校验，非法组合不消耗 `revision`、不覆盖已有合法 `pending`，并发双写取代时返回请求自身 `revision` 的受理快照。
- **Relay Wire 1.4、Companion 与 `@roll-agent/relay-client`**：新增受限远端方法 `thread.effort.get`（query）与 `thread.effort.set`（mutation）（不暴露本地模型目录、`selection` 与 `contextWindow`，`active.provider`/`active.model` 长度上限与 Runtime 身份保持 128/512 对齐），在 `RELAY_ERROR_CODES_V14` 中新增窄公开错误码 `THREAD_EFFORT_STATE_STALE`（`retryable: true`）与 `THREAD_EFFORT_UNSUPPORTED`（`retryable: false`）；`roll companion enroll`、`roll companion enable`、`roll companion run` 新增 `--relay-protocol-version <1.2|1.3|1.4>` 与 `ROLL_COMPANION_RELAY_PROTOCOL_VERSION` 入口，默认保持 `"1.2"` 兼容旧版 Relay；`@roll-agent/relay-client` 在 `RelayThread` 上新增 `getEffort()` / `setEffort()` 并导出 `RELAY_ERROR_CODES_V14` 与 `isThreadEffortToggleEnabled()`，同时在初连与重连握手阶段严格校验对端返回的 `session.ready.relayProtocolVersion` 属于本次实际 offer 列表。
