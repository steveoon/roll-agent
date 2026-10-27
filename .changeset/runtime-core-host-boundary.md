---
"@roll-agent/runtime": major
"@roll-agent/core": patch
---

Make Runtime independently consumable by removing its reverse dependency on Core. `ConversationEngine` now requires execution-only `RuntimeSettings`, an injected model and its provider/model identity; dynamic Agent integration uses an `AgentHost` instead of Core registries and MCP managers. Static tool sources remain caller-owned. Skills, tool validation and host contracts are available through dedicated leaf exports.

Core assembles the existing chat, Runtime service, Companion and scheduler entry points through the new host boundary, preserving CLI configuration, approval, recovery, persistence and wire behavior. Direct Runtime TypeScript consumers must migrate their engine construction and model-switch integration to the new contracts.
