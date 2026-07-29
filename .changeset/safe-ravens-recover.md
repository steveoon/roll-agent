---
"@roll-agent/core": minor
---

为 core-managed HTTP Agent 增加中断租约释放的产品级恢复：`roll agent health` 与
`roll doctor` 会识别并报告可恢复状态，`roll agent stop <name>` 在交互确认后完成恢复，
非交互环境可显式使用 `--recover`。

恢复流程会重新获取 lifecycle lock，并再次验证租约 owner、Runtime 进程身份、其他活动
租约及文件身份；任何状态无法证明安全时继续拒绝停止和清理。
