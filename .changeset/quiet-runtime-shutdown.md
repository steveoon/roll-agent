---
"@roll-agent/core": patch
---

Let the stdio Runtime exit naturally after releasing sessions, agent connections and the thread store. This avoids a Windows private Node crash when forcing process exit after HTTP provider requests, while preserving signal exit codes and client shutdown escalation.
