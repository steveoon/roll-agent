---
"@roll-agent/core": patch
---

Switch the qwen provider integration to the official `@ai-sdk/alibaba` provider.
This fixes `roll ask` / `roll run` compatibility when using DashScope Qwen models through the core LLM layer.
