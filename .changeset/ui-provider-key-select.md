---
"@roll-agent/core": minor
---

`roll ui` 与 `roll setup` 添加 LLM provider 时改为从内置清单预选

- 配置台 `llm.providers` 新增条目改为下拉，只列出 core 支持的 provider（anthropic / openai / qwen / deepseek / xai / google），并显示厂商名与默认模型，避免手输 `grok`、`gemini` 这类运行时不识别的 key
- `llm.default-provider`、`runtime.provider` 在配置台改为下拉；配置文件里已存在的非清单值仍可原样编辑
- `roll setup` 的 provider 选项显示厂商名（如 `xai · xAI Grok`）
