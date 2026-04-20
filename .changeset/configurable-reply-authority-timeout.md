---
"@roll-agent/smart-reply-agent": patch
---

feat(smart-reply): make Reply Authority HTTP timeout configurable via `REPLY_AUTHORITY_TIMEOUT_MS`

- 新增可选环境变量 `REPLY_AUTHORITY_TIMEOUT_MS`，支持通过 `agents.env.smart-reply-agent` 注入，覆盖默认超时
- 默认超时从 20_000ms 调整为 30_000ms（更贴近真实网络波动下 Reply Authority Service 的响应分布）
- 严格解析：非正整数、含空白或科学记数法等非规范值会静默回落到默认，避免意外的短超时
- `diagnostic_status` 诊断 tool 会返回该 env 的 `{present, fingerprint}`，`roll agent info` 据此展示 `未设置（使用默认值）` / `✓ from yaml (stable)` / `⚠ from shell (ephemeral)` 等漂移标签
