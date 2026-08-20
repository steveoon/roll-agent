---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

roll chat 输入解析修复：以文件路径等非命令形状开头的消息不再被误判为 slash 命令

- 只有命令形状的首 token（`/` + 字母/数字/连字符）才进入 slash 命令/skill 解析；`/Users/...` 这类路径开头的输入按普通消息发送，TUI 层与会话层（explicit skill context）行为一致
- skill 前缀后跟路径参数（如 `/some-skill /path/to/file 请求`）不再误报「未知 skill」，路径正确归入 prompt
- `/` 弹窗过滤支持子串命中（如 `/zhipin` 命中 `/roll-zhipin-unread-reply`），前缀命中优先排序
- 未知命令提示后保留输入草稿，便于修正拼写；输入命令参数时不再渲染空的「无匹配命令」弹窗
