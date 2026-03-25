# Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| Connection error / timeout | `browser-use-agent` not running | `roll agent start browser-use-agent` |
| Empty candidates / missing elements | Wrong page context | `navigate_active_tab` to the required page |
| `"消息列表未加载"` | Chat tool called outside chat page | Navigate to `https://www.zhipin.com/web/geek/chat` |
| `"未找到候选人"` | `candidateName` did not match chat list entry | Check spelling or switch to `index` |
| `"未找到打招呼按钮"` | Not on recommend page, or candidate already greeted | Navigate to recommend page first |
| `"未找到确认按钮"` / `"未找到换微信按钮"` | Wechat already exchanged, or UI state changed | Check chat history before calling again |
| `"确认对话框未弹出"` | UI timing issue | Retry once |
| Agent tool returns 401 / missing config / wrong endpoint behavior | Agent runtime did not receive required env vars, or upstream provider rejected the supplied key | First check `roll agent info <agent-name>` env section; then update `agents.env.<agent-name>` in `roll.config.yaml`; only after that verify provider/key validity |

Before `zhipin_exchange_wechat`, it is safer to inspect chat history first. If `zhipin_get_candidate_info` already shows a `wechat-exchange` style message, skip the exchange call.
