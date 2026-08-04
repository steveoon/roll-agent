---
"@roll-agent/runtime": minor
"@roll-agent/client-node": minor
"@roll-agent/core": patch
"@roll-agent/relay-protocol": patch
"@roll-agent/companion": patch
---

Negotiate Runtime Protocol 1.2 Server Request capabilities before delivery, carry branded
Interaction metadata on Approval requests, cancel 1.2 requests by InteractionId, and keep the
Protocol 1.1 and 1.0 control paths wire-compatible.
Freeze Relay Wire 1.0 against Runtime 1.2 schema drift and project newer Runtime snapshots and
events to its existing Runtime 1.1-compatible envelope before remote delivery.
