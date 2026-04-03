---
"@roll-agent/smart-reply-agent": patch
---

fix: Anthropic structured output compatibility for planTurn

- Strip unsupported JSON Schema keywords (`maxItems`, `maximum`, `minimum`, `exclusiveMaximum`, `exclusiveMinimum`) from output schema sent to Anthropic models
- Add `normalizeGeneratedTurnPlanOutput` to clip over-limit arrays before strict Zod validation
- Only triggered when `classifyModel` starts with `anthropic/`; other providers unaffected
- Original strict schema remains the internal contract — compatibility layer only affects what is sent to the LLM
