---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

Upgrade the DeepSeek provider to preserve reasoning history for `deepseek-flash` in multi-turn tool calls. Adapt strict tool generation hints to DeepSeek standard endpoints while retaining local schema validation and explicit beta strict mode, and recognize the model's 1M context window when no catalog entry is available.
