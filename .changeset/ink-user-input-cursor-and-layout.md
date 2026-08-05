---
"@roll-agent/core": patch
---

Fix the Ink user-input form's text controls anchoring the real terminal cursor one or two rows
below the input line (the embedded TextPrompt assumed it sat flush with the viewport bottom, so
IME preedit text rendered outside the box and typing looked dead until the form timed out).
TextPrompt now accepts a bottomOffset for rows rendered beneath it, and the form layout gains a
consistent one-column indent, spacing between the header and the active control, and a yellow
required marker.
