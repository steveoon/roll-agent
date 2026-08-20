---
"@roll-agent/core": minor
---

roll chat 新增 Ctrl+Y 一键复制最后一轮对话（用户消息 + 助手回复）

- 复制内容为最近一条用户消息与其后的助手回复正文（不含 thinking 与工具输出），格式 `用户: ...\n\n助手: ...`
- 双通道写入：OSC 52（tmux 下自动包 DCS passthrough，SSH 场景可用）+ macOS `pbcopy` 兜底
- 复制成功/无可复制内容均有提示；`/help` 增加快捷键说明
