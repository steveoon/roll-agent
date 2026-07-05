---
"@roll-agent/core": minor
---

chat 模式新增 Auto Mode，并重设计工具确认框。

- **Auto Mode**：Shift+Tab 随时开关自动批准工具调用（backtab 与 kitty 协议编码均支持）。开启后确认（Yes/No）被自动批准不再打断执行；正在等待确认时按 Shift+Tab 会立即批准当前待决项并对后续生效（对齐 Claude Code 交互）。新增 `/auto` 命令（`on` / `off` / 无参切换）兜底部分终端拦截 backtab 的场景。开启时输入框 hint 与状态栏显示黄色 `⏵⏵ auto` 徽标（状态栏窄屏不丢弃该段）；每会话默认关闭，不持久化
- **确认框重设计**：黄色圆角边框（延续输入框形状语言，避免确认时 footer 布局塌陷）；显示工具入参（经脱敏与 80 字符截断），不再盲批；新增快捷键提示行（含 Esc 取消与 Shift+Tab 说明）；`Y`/`N` 大写输入同样生效
- 纯 UI 层实现：runtime 的 ToolPolicy 与 approve/reject 协议不变，policy `deny` 仍然直接拒绝
