---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
"@roll-agent/protocol": minor
"@roll-agent/client-node": minor
---

Add optional model configuration reload to the local Runtime protocol. A client can apply model and provider changes from the Runtime's bound configuration without reopening conversations. Active turns finish on their original model. The Runtime applies the latest configuration after those turns settle and exposes the application status to clients.
