---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

roll chat 启动 banner（Roll Agent logo）。

- 交互式 REPL 启动时显示 ROLL 块字符 logo（cyan→magenta 六档渐变），信息行以品红 `Roll Agent` 开头，跟随版本/模型/agent 数/skill 数与按键提示
- 降级链：非 Unicode 终端（如 PowerShell 5.1 conhost）换 slant 斜体 ASCII 渐变版；窄于 28 列省略 logo 只保留单行信息；`--json`、单条消息与 `--server` 模式不显示
- ink TUI 中 banner 作为首条 `<Static>` 历史项渲染一次即沉入滚动缓冲区；readline 回退模式输出到 stderr
- 修复启动时 `^[[?0u` 字符泄漏（kitty 键盘协议查询响应在 raw mode 生效前被终端回显，且会破坏 ink 首帧渲染）：render 前预开 raw mode
- 新增 `ConversationEngine.getContextSummary()` 公开 API，返回已连接 agent/tool/skill 计数
