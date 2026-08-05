---
"@roll-agent/core": patch
---

Rework the Ink user-input form interaction: Esc now steps back to the previous control with its
confirmed value restored (cancelling only from the first control), confirming the last control
opens a review summary where any answer can be revisited before an explicit submit, and boolean
controls default to 否 in both the Ink form and the clack REPL. Optional boolean controls in the
clack REPL gain the same skip capability as the Ink form via a skippable 是/否 select.
