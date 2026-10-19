---
"@roll-agent/core": patch
---

Add experimental ChatGPT subscription sign-in for roll chat and scheduled tasks, with shared CLI/configuration UI account management, dynamic subscription models, streaming Responses, local tools, Sampling and compaction. Map reasoning controls to supported subscription parameters and load subscription model choices on demand. Keep API-key routing available.

ChatGPT subscriptions are not yet supported by Runtime service, Companion or the legacy `roll chat --server` entry point. Saving ChatGPT as the shared `runtime.provider` / `runtime.model` default also affects those entry points on their next startup; use an API-key provider in their configuration. The configuration UI explains this limitation before saving subscription defaults.
