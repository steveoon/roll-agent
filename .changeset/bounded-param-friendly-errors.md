---
"@roll-agent/runtime": patch
---

数值边界参数统一由 boundedIntParam 从同一份 min/max 派生 JSON schema 边界与描述文字（bash 的 timeout_ms/max_output_chars、exec 的 yield_time_ms/max_output_tokens、grep 的 context/max_results），模型第一次调用即知范围；越界/类型错误在 prepare 与 AI SDK tool-error 归一的唯一入口经 describeZodIssues/friendlyInvalidToolInputMessage 生成一句话友好文案（参数名、允许范围、所传值），不再吐 zod 原文。read_file 读取 roll 自产落盘目录不再触发工作区外审批，prepare 校验同样走共享友好格式化。
