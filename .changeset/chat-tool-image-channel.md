---
"@roll-agent/sdk": minor
"@roll-agent/runtime": minor
"@roll-agent/browser-use-agent": minor
---

chat 端到端图像链路：工具截图可直接被多模态模型识别

- SDK：工具结果新增 `mcpImages` 约定字段（导出 `ToolResultImage` 类型），`executeToolForMcp` 将其摘出为 MCP 标准 image content block，base64 不再混入文本 JSON 载荷
- runtime：tool result 中的 file part（图像）改走独立预算（`MAX_TOOL_MODEL_FILE_CHARS`，12M 字符），不再被 60k 文本预算截断——图像 token 成本按分辨率计算而非字符数
- runtime：新增 `relocateToolImagesToUserMessages` 幂等消息变换，经 `streamText` 的 `prepareStep` 在每步请求前把 tool 消息中的图像搬运到紧随的 user 消息——dashscope 等 provider 对 tool 角色消息中的图按纯文本计入 input length，仅 user 消息中的图走视觉通道
- browser-use-agent：`zhipin_capture_resume` 返回值携带 `mcpImages`，chat 模式下模型可直接看到简历截图（实测 qwen3.7-plus / grok-4.5 / gpt-5.5 皆可识别并继续调用工具）
