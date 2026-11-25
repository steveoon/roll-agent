---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

升级 AI SDK 生态依赖（`ai`、`@ai-sdk/provider` 及全部内置 provider），并补齐 Google `thoughtSignature` 与流式中断适配：

- 跳过空文本/空推理签名载体流帧对思维摘要认证与文本流事件的干扰，并在持久化与重开后原位保留不透明空推理签名供原模型回放
- 切换至 DeepSeek（含 `/beta`）、OpenAI、ChatGPT 订阅、xAI、Anthropic、Qwen 等其他 provider 时剥离外源空签名载体，避免发送空 assistant 消息
- 在模型流因 `interrupted` 或遗留未配对工具调用中断时如实结束，保留已完成步骤与部分正文，以 `not_executed` 记账，不杜撰工具结果或重放副作用
