---
"@roll-agent/browser-use-agent": patch
---

修复 macOS 上批量回复 BOSS 直聘未读消息时，发送瞬间弹出系统「关于本机」窗口的问题。

- 根因：`native-page.ts` 的 `selectAllFocusedText()` 在发送回复前用合成键盘事件 `Cmd+A`（带 Command/Ctrl 修饰键）清空输入框，该事件在网页未消费时会泄漏到 macOS 系统快捷键层，触发系统窗口。
- 修复：全选改用页面内 JS `Selection` API（contenteditable 走 `range.selectNodeContents`，input/textarea 走 `el.select()`），不再发送任何带修饰键的合成键盘事件；删除仍用无修饰 `Backspace`，「清空再输入」的语义不变。
- 全选走现有 `evaluateJson` → `Runtime.evaluate`，不引入 `Runtime.enable`，无新增自动化指纹面。
