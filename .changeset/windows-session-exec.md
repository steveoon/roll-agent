---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

在 Windows PowerShell 7+ 上启用 `roll chat` 会话式长命令执行，新增有界的 `exec_list`
恢复入口，并补全跨轮轮询、本轮 Esc 中断、轮超时保活与可等待的关闭清理语义。
无法确认进程树已清理的会话会显式返回 `cleanup-failed`，并在读取该终态前继续占用会话名额。
