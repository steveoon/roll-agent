---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

Update AI SDK to 7.0.146 and refresh the OpenAI, Anthropic, Google, DeepSeek,
Alibaba, and xAI providers. Core and Runtime use provider types 4.0.31. The xAI
upgrade retains Roll's existing Responses API integration; configuration keys
and model selection remain unchanged.

Pin OpenAI to 4.0.59: newer versions filter reasoning efforts using a fixed model
list, which would silently drop `none` even when the ChatGPT model catalog
advertises it. Preserve catalog-driven thinking settings without changing the
subscription transport.

Preserve same-turn ChatGPT recovery when the SDK wraps an interrupted response
body in a successful-HTTP-status error. Recovery still requires typed transport
evidence; parser, authorization, and quota failures remain terminal.

Update the shared AI SDK HTTP dependency, undici, to 7.30.1 to include its
security fixes. All selected versions satisfy the existing seven-day release
cooldown.
