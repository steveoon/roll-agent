---
"@roll-agent/core": minor
---

feat(core): qwen provider structured output 兼容性增强

- 新增 resolveLLMCall()，qwen + structured-output 场景自动注入 enableThinking: false
- LLM 路由新增 text fallback，模型不遵循 json_schema 时降级为纯文本 + JSON.parse
- 升级 AI SDK 全线依赖至最新版本
