---
"@roll-agent/sdk": minor
"@roll-agent/browser-use-agent": minor
---

同一 `browserInstance` 的页面操作工具在服务端互斥串行，修复 chat 模式并行 tool call 在同一浏览器实例上互相踩踏的竞态。

**browser-use-agent**：新增 per-browserInstance 互斥队列（`browser-instance-lock.ts`），经 `withBrowserInstanceInput` 接入——同实例页面操作排队依次执行，不同实例保持并行。`browser_status`、`list_pages`、`attach_browser_session`、`zhipin_diagnose_browser_state` 等 page-free/只读诊断工具不进锁，保证实例被长操作占用时排障出口依然可用（`browser_stop`、`zhipin_judge_prepared_reply` 本就绕过实例包装，不受影响）。发生争用时输出排队等待日志。

**@roll-agent/sdk**：`AgentContext` 新增可选 `signal: AbortSignal`（per-request），`registerTool` 将 MCP 请求的取消信号透传给工具。排队等待期间客户端已超时/取消的请求，出队时会被直接丢弃并返回 `cancelled_while_queued`（含 `browserInstance` 与 `queuedMs` details），保证"客户端已放弃的请求不再落地执行"，避免超时重试导致 `say_hello`/`exchange_wechat` 这类副作用操作重复执行的幽灵操作风险。

对遵守 one worker → one browserInstance 编排规范的 orchestrator 零行为变化：同实例顺序调用永远无锁争用。SKILL.md 已同步说明排队语义与"超时重试前先用读工具验证"的指引。
