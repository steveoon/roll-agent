---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

`roll chat` 增加 token 用量可见性与上下文自动压缩。

- 每轮对话结束后默认显示 token 用量(本轮 in/out、session 累计、context 占用 %),不再需要 `--verbose`;`--json` 输出新增 `sessionUsage` 与 `contextWindow`。
- 上下文接近模型 context window 时自动压缩(reactive:依据上一轮 provider 实测的 input tokens 判断,无需 tokenizer):默认把最早若干轮经 LLM 摘要折叠成一条 summary 并保留最近 N 轮原文,`runtime.compaction.strategy: truncate` 可改为零成本滑动窗口截断。
- 压缩同时对保留轮内的超大工具结果(如 `browser_snapshot` 的完整 a11y 树)做内容截断,使含巨型工具输出的会话在压缩后真正回落到窗口内,而不是仅折叠最早几轮却仍然撑满。
- 压缩进行中显示「压缩上下文中…」spinner,完成后汇报移除/保留条数与精简的工具结果数,避免长压缩看起来像卡死。
- 若 provider 报 context 长度错误,当前轮会回滚用户输入并立即尝试压缩已持久化历史;摘要压缩失败时自动降级为 `truncate`,避免继续用未压缩历史重试。
- REPL 支持 `/compact` 手动压缩,工具确认恢复为方向键选择(clack);runtime server 新增 `session.compact`;`runtime.compaction.enabled: false` 可关闭自动压缩。
- context window 经 `runtime.context-window` 显式声明,未声明时回落内置模型表;无法识别时阈值自动压缩不可用,但明确的 context 长度错误仍会触发恢复性压缩。

已知限制:压缩是 reactive 的(超阈值后下一轮才触发),单轮超大输入瞬时撑爆 context window 仍可能先触发一次 provider 报错,再由恢复性压缩在下一轮收敛。
