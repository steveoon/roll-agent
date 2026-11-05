---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

Provide `roll runtime migrate` to explicitly confirm, back up and upgrade an older session library without configuring an LLM. Old-schema CLI errors now point to this recovery command; active claims and unsupported future schemas remain protected.

Release a thread deletion's temporary claim and closing state when database deletion fails after session cleanup has completed. Preserve fail-closed ownership when cleanup itself fails, and allow retry or another client to reopen surviving history after a recoverable write failure.
