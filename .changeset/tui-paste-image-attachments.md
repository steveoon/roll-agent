---
"@roll-agent/core": minor
---

`roll chat` Ink TUI 支持拖拽/粘贴图片文件与 Ctrl+V 剪贴板图像作为消息附件

- 拖拽文件进终端或粘贴图片路径（裸路径、shell 转义空格、引号包裹、`file://` URL、`~` 前缀、多文件混合）自动识别为附件，不再以路径文本插入输入框
- Ctrl+V 读取 macOS 剪贴板：Finder 复制的图片文件（`«class furl»`，经 `clipboard info` 精确判定避免纯文本被 furl coercion 误吞）与位图数据（`«class PNGf»`，截图场景）均可入附件；读取期间 chip 行显示「读取剪贴板…」，无图/超限/失败以 notice 提示，非 macOS 平台提示暂不支持
- 输入框上方渲染附件 chip 行（`📎 文件名 大小`），空输入时退格移除最后一个附件
- 支持 png/jpg/jpeg/gif/webp，单文件 8MB 上限；文件不存在或含非图像 token 时按普通文本粘贴放行，读取失败以 notice 提示
- 发送走 `AgentSession.send({ text, attachments })`，支持纯图无文本消息；用户历史项与 `/resume` 水合均显示 `📎` 附件标注
