---
"@roll-agent/browser-use-agent": minor
"@roll-agent/core": minor
---

Add an experimental bounded browser_operate loop with Roll MCP Sampling as its default decision engine. Roll's new `browser.operate.engine: jev` setting explicitly enables the fast TypeSafe Jev mode; configure `TYPESAFE_API_KEY` through `agents.env.browser-use-agent` in roll.config or the UI Agent environment editor. The tool's legacy `engine` input cannot override Roll configuration, and fast mode fails before browser access when the key is missing. Both engines share the same task loop, which selects observed actions, targets and caller-source values without a secondary model for preparation, per-field checking, generation or recovery. The fields strategy retains ordered supplied-value execution.

Copy full supplied values or bounded verbatim goal spans; return unmatched inputs to Roll for missing facts or prepared content. Open editors before discovering their inputs. Preserve native policy, origin, ref, target-freshness, exact input readback and uncertain-action guards. Stop on stagnation without hidden host fallback.

Return final observations, source records and choice distributions with verified:false. Roll verifies the whole original goal after interaction and corrects only mismatches; model_done is not certified success. Legacy helper-budget inputs remain accepted but unused; task-mode textCalls is empty and recoveryDecisions is zero.

Provide generic picker ownership, trigger/option distinctions and provenance-tagged labels to browser decision models. Separate query, display and committed values, preserve explicit expanded state during asynchronous loading, and describe actions by their field relationship. Menu text matches no longer imply completed fields; ambiguous ownership and backing values remain unknown.

Bound model-facing request previews while preserving all action IDs and full execution text. Deduplicate repeated descriptions and input tables. Evaluate whole-goal completion in the same primary request, distinguishing unresolved requirements from open panels, and preserve verbatim user goals/text through Roll preparation. Surface recognized token-limit errors without exposing upstream bodies.
