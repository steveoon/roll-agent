---
"@roll-agent/core": minor
---

Companion 接通官方生产 Relay host，enroll 与出站长连接可用

- 官方 Relay host 定为 `sponge-mcp.duliday.com`（此前为未决 `null`，enroll / 出站长连接全部 fail-closed 不可用）。`isOfficialRelayEndpointDecided()` 与未决文案保留。
- 端点解析收敛为 `resolveRelayEndpoint()` 单一数据源：新增 `ROLL_COMPANION_RELAY_HOST` 环境变量覆盖（联调用），仅 loopback 覆盖允许降级 `ws://`/`http://`，非 loopback 一律 `wss://`/`https://`，非法覆盖值（带 scheme / 路径 / 空格 / 凭据）继续 fail-closed 抛错。
- Runtime Protocol 校验从硬钉字面量 `"1.3"` 改为跟随 `@roll-agent/protocol` 的 `RUNTIME_PROTOCOL_VERSION`，消除 protocol 升到 1.4 后 companion 会话必然抛错的问题；错误信息带上期望与实际版本。
- supervisor 会话失败的 `lastError` 与日志保留底层原因（原先一律折叠为 `Companion session failed`，无法定位根因）。
- `roll companion doctor` 的 `relay-endpoint` 检查与前台启动日志区分官方 host 与 `ROLL_COMPANION_RELAY_HOST` 开发覆盖。
