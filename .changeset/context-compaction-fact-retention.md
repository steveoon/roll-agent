---
"@roll-agent/runtime": patch
---

Preserve complete evidence during semantic compaction so important facts in the middle and tail of messages and Tool results can reach the next model request. Require whole-source review before retiring long evidence, retain original history on invalid or incomplete summaries, and avoid silently truncating retained Tool results. Remove duplicate quoted text in checkpoint reminders and continue bounded maintenance toward a lower recovery target without making that target an admission requirement.

Pack summary batches using a UTF-8 token estimate after reserving space for the actual output schema, provider options, and output budget, and check the final SDK request before dispatch. Avoid repeated explanations in summary output and accept exact quotations spanning complete consecutive sentences, so valid facts are not rejected merely because a source line contains several sentences.
