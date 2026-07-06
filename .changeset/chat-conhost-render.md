---
"@roll-agent/core": patch
---

chat TUI 渲染性能与 Windows legacy 终端体验修复（实测反馈：PowerShell 5.1 流式输出闪烁、emoji 方块）。

- **历史区改用 ink `<Static>`**：已提交的对话历史只渲染一次并沉入滚动缓冲区，动态重绘区缩小到流式区 + 状态栏 + 输入框。修复 legacy conhost（PowerShell 5.1/cmd）上对话变长后触发 ink 整屏清除路径导致的持续闪烁；所有终端上长对话的重绘开销也大幅下降（含键击热路径的历史数组复制消除）
- **emoji 字形降级**：`🧠`/`⏵⏵`/`🗜` 在不支持 Unicode 的终端（legacy conhost）降级为 `think`/`>>`/`*`，消除方块乱码；Windows Terminal 与 macOS 不受影响
- **转写区内边距**：历史与流式内容统一 1 列水平缩进（工具行 3 列，流式活跃工具行对齐），输入框/确认框内边距由 1 列加宽到 2 列，hint 行随缩进对齐
- **终端宽度为 0 的防御**：`stdout.columns` 报 0（conhost 窗口调整瞬间、部分 CI PTY）时不再逐字符竖排折行，回退 80 列
- **流式提交零跳变**：live 区流式文本补上与历史 assistant 条目一致的上边距，提交瞬间文本不再垂直位移
