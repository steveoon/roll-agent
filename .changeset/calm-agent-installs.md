---
"@roll-agent/core": patch
---

Serialize concurrent `roll agent install` calls with an owned sibling lock while keeping npm's final prefix stable, and clean up only directories owned by a failed invocation.
