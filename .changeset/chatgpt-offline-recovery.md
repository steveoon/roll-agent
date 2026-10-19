---
"@roll-agent/core": patch
---

Keep interactive ChatGPT chat available during network and authorization failures. Preserve local history and input, recover credentials and the account model catalog in the background or on send, and add `/reconnect` without restarting chat. Retry transient read failures with bounded timeouts while avoiding automatic replay of rotating token exchanges or uncertain inference requests.

Finish saving dispatched token rotations independently of chat cancellation, cancel account-lock waits promptly, synchronize recovered context limits before turns, and retain connection recovery across model switches.
