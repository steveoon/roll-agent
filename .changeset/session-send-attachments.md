---
"@roll-agent/runtime": minor
---

`AgentSession.send()` 支持图像/文件附件输入（TUI 粘贴、GUI/WebUI 附件闭环的引擎底座）

- `send()` 签名扩展为 `string | SessionSendInput`（`{ text, attachments?: [{ data: base64, mediaType }] }`），纯字符串调用方零改动
- 带附件时用户消息以 AI SDK parts 数组构造（text part 在前、file part 在后，空文本纯附件省略 text part），无附件时保持 string content，ThreadStore 持久化经 `modelMessageSchema` 原生兼容
- 显式 Skill 上下文（`/<skill> 请求`）应用到带附件消息时只替换文本、保留 file parts，不再整体覆写
- compaction evidence 渲染前统一脱敏内联二进制：用户消息 file/image part 与 tool-result 输出中的图像 base64 均替换为占位符，防止历史图像数据灌入 compaction prompt
- 新增导出类型 `SessionAttachment` / `SessionSendInput`
