---
"@roll-agent/core": minor
---

roll chat 新增 /resume 命令：Ink TUI 与基础 REPL 均可在对话中列出已有会话并切换。切换先恢复目标会话成功后才关闭当前会话，失败时当前会话不受影响；切走的零消息新会话自动清理；Ink 侧切换后完整重建 transcript 历史。
