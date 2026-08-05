---
"@roll-agent/client-node": patch
---

Accept Runtime capability ACKs that return the registry-ordered intersection of the requested
Server Request methods, as the protocol contract specifies. The client previously demanded an
element-and-order-exact echo and failed the connection on any legal subset, so a client-node
newer than its Runtime could never negotiate. Unrequested methods and revision mismatches are
still rejected, dropped methods answer -32601, and the redundant internal handler mirror map
was folded into the single handler registry.
