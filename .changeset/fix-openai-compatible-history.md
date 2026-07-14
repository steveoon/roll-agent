---
"@roll-agent/core": patch
---

Fix multi-turn `roll chat` failures against OpenAI-compatible Responses endpoints by replaying
conversation history instead of relying on server-stored response item IDs.
