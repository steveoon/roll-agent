---
"@roll-agent/core": minor
---

`roll chat` 全屏 TUI 默认把已完成的思考内容折叠为一行痕迹（思考时长与字数），模型开始正式回复后不再让思维链霸占对话记录；思考进行中仍实时展示。新增 `chat.thinking-display`（`collapsed` | `expanded`，默认 `collapsed`）配置控制默认行为，会话内可用 `/show-think [on|off]` 临时切换。基础 REPL 本来就不渲染思考内容，`--json` / `--server` 路径不下发原始 reasoning，均不受影响。
