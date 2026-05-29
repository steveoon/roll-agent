---
"@roll-agent/browser-use-agent": patch
---

修复智能回复 `message_sent` 埋点丢失未读上下文导致 dashboard 回复率/被回复人恒为 0 的问题。

- `zhipin_generate_reply_preview` 在读取聊天详情后派生 `unreadCountBeforeReply`：优先取真实红点（`nav.unreadCount > 0`），否则当预览上下文里最新有效人类消息来自候选人时保守推断为 1，再否则为 0；该值随预备回复一并保存。
- `zhipin_send_prepared_reply` 将保存的 `unreadCountBeforeReply` 透传给 `sendSignedZhipinReply()`；发送阶段如重新 `openChat()` 拿到更大的真实未读数，用 `Math.max()` 保留更可信数值。
- 不新增任何外部 MCP tool 参数，不改变 `zhipin_generate_reply_preview` / `zhipin_send_prepared_reply` / `zhipin_send_reply` 的公开输入输出契约；`message_sent` 继续以 `unreadCountBeforeReply > 0` 生成 `wasUnreadBeforeReply=true`。
- 仅修复未来埋点，历史数据不自动回填。
