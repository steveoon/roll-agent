---
"@roll-agent/protocol": minor
---

Add `normalizeUserInputResultForForm(form, result)` for validating a user input result against
a bare form without Interaction metadata; `normalizeUserInputResult(params, result)` now
delegates to it. Document that clients must treat `acceptedServerRequestMethods` in the
capability ACK as a set-semantics subset of the requested methods.
