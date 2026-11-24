---
"@roll-agent/core": minor
---

对齐 Google Gemini 4 模型推理强度能力与 `@ai-sdk/google`：

- `gemini-4-neon`、`gemini-4-hydrogen` 开放 `low` / `medium` / `high` / `xhigh` 原生 `thinkingLevel`（支持 chat、MCP Sampling、structured-output 压缩及配置台/CLI 交互），请求前拒绝 `off` 与 `max`
- `gemini-4-carbon`、`gemini-4-argon` 独立限定为 `low` / `medium` / `high`，请求前拒绝 `off`、`xhigh` 与 `max`；旧代 Gemini（3.x / 2.5）行为保持原契约
- 统一在共享能力入口按末段模型标识规范化匹配，修复 `models/` 前缀与完整资源名（`projects/.../models/<model>`）在自定义 `baseURL` 下的误判；前后端对未解析 `provider/model` 环境变量占位符一致推迟依赖未知身份的判定
- `roll ask` 和 `roll run` 使用独立 API 模型时，如果聊天档位合法但目标模型不支持，仅独立采样降为 `medium`，并通过 stderr 提示。例如，Gemini Neon 的 `xhigh` 可以搭配 OpenAI API，ChatGPT 订阅的 `off` 可以搭配 Grok 4.5。
- 独立采样也会校验聊天源模型的档位。若将 Grok 4.5、4.6 或 4.7 的聊天档位配置为 `off`，即使独立 API 支持 `off`，命令也会在调用工具前报告配置错误。
- `/model` 切模型先校验未知模型再判定档位选择，遇显式 `runtime.compaction.thinking-level` 不兼容时明确指出压缩配置字段并保留旧模型、会话与原档位
