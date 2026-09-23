# Generic browser decision loop experiment

Worktree: `codex/jev-browser-benchmark`, based on `bfbbe77` plus the recorded form-recovery baseline patch. Original checkout and running baseline service remain separate.

## Implementation

1. Add a bounded `browser_operate` tool: observe, ask typed questions, execute one validated action, repeat. Reuse native CDP/ref guards and hold the existing browser-instance lock for the complete operation.
2. Use TypeSafe's official `/v1/systemone` Jev API with `TYPESAFE_API_KEY` configured in `agents.env.browser-use-agent`; keep MCP Sampling only for the configured-model comparison. Record both requested and resolved model IDs.
3. Keep text values supplied by the caller on the host. The model selects value IDs and observed refs; it cannot generate scripts, selectors, or replacement job descriptions.
4. Bound origins, iframe observation, step count and elapsed time. Recheck live policy for mutations, stop uncertain actions without replay, and report model completion separately from verified completion.
5. Test protocol validation, cancellation, invalid decisions, partial-action failures and frame boundaries, then typecheck/lint/build.

## Measurement

Run on a new, unsaved BOSS form using the recorded reference job. Never publish. Reset and independently verify each initial and final state. Keep task data, origin scope, tool approval policy, timeout and completion oracle fixed. Record end-to-end, observation, decision, action and approval time, call counts, failure/retry counts and actual model version.

Compare A (stabilized current Runtime orchestration), C (internal loop with current model) and D (same loop with Jev). B is only meaningful if execution-only changes are introduced; do not attribute an omitted B to model improvement. Previous stabilization runs are development evidence, not matched performance baselines. Target is elapsed-time reduction of at least 50%, ideally 80%, with correctness maintained.

## Runtime integration follow-up (2026-09-20)

- Scope field status decisions to the active requirement; suppress repeated clicks and repeated page states.
- Do not advance requirements while a modal picker remains open. Restrict input values to the active requirement or the observed control context, and expose actual custom checkbox controls and checked state.
- Honor bounded MCP execution-timeout metadata while preserving cancellation.
- Run the real CLI Runtime against private registry/config/thread directories, with the same configured orchestration model and preauthorized form-only tools. Start both arms from a visible, unobscured, blank unsaved form. Retain all failed/setup attempts.
- Validate the reported address-picker counterexample independently before rerunning full workflows.
