---
"@roll-agent/core": minor
---

`roll chat` Ink 输入框支持完整光标编辑（readline-lite），Windows 与 macOS 键位同时生效。

- 新增 grapheme-aware 纯函数编辑模型 `line-buffer`（基于 `Intl.Segmenter`），所有插入与删除在文本拼接后重新归一光标边界，汉字、emoji ZWJ 序列、组合字符不会被劈半；显式多行草稿支持行间 ↑/↓ 移动并按终端显示宽度列记忆 goal column。
- 新增数据驱动键位绑定表 `editor-keymap`：←/→ 移动、Home/End 与 Ctrl+A/E 行首行尾、Ctrl+←→（Windows 习惯）与 Option+←→（macOS 双编码 ESC b/f 与 CSI 1;3）词跳转、Ctrl+W/Option+Backspace 删词、Ctrl+U/K 删到行首/行尾。平台差异是同一语义命令的多条绑定数据，无平台探测分支。
- 光标以反色渲染于所在字符，替换原行尾装饰性假光标；普通输入、IME 多字符与粘贴均插入在光标处。
- 行为变化：Delete 键（`ESC[3~`）从等价退格改为正向删除（光标在末尾时为 no-op）；启用 bracketed paste（Ink `usePaste`）后粘贴含换行的文本会整段插入光标处，不再触发提交。不支持 bracketed paste 的终端维持原行为。
- slash 弹窗激活时 ↑/↓/Tab 仍优先服务候选选择；Shift+Tab、Alt+./,、Ctrl+J 换行与 kitty 协议残留过滤等既有行为不变。
- `displayWidth` 从 `markdown.ts` 抽至独立 `display-width.ts`，统一使用与 Ink 相同的 grapheme-aware terminal width 语义，修正 emoji modifier、ZWJ、旗帜与 emoji presentation 的列宽；Markdown 表格、状态栏、命令列表截断和纵向光标共享同一算法。
- CI `windows-shell-smoke` 新增 display-width / line-buffer / editor-keymap / text-prompt 四个测试文件，宽度与键位测试（legacy VT 与 kitty 双编码）在 windows-latest 真实运行。
- ↑/↓ 以草稿中的显式换行为行边界；终端自动软折行不参与光标行模型。
