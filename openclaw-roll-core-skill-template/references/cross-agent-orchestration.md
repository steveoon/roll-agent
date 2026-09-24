# Cross-Agent Orchestration Patterns

Use this file for shared sequencing patterns that only appear when multiple Roll agents cooperate. Keep agent-specific tool schemas in each target agent's own `SKILL.md`.

## Core Principle

Prefer explicit, verifiable chains over optimistic single-shot automation.

When multiple agents cooperate:
1. Verify the upstream agent/runtime state first.
2. Refresh shared context before generation when the target brand / tenant / workspace changes.
3. Pass only the minimum validated output from one agent into the next.
4. Add an external verification step after side effects (send, write, create, update, click, type).

## Pattern 1: Read -> Generate/Preview -> Resolve -> Send -> Verify

Use this pattern when one agent reads state, a generator or preview tool prepares content, and a
sender performs the external side effect.

Example shape:

```bash
# 1. Read latest state
roll run <reader-agent> <read-tool> --input-json '{...}' --json

# 2. Generate or preview response from validated input
roll run <generator-agent> <generate-or-preview-tool> --input-json '{...}' --json

# 3. Optional: resolve alternatives only when the target contract requires or exposes this step.
#    The decision may instead be sender-owned.
roll run <decision-agent> <judge-or-decision-tool> --input-json '{...}' --json

# 4. Prepare or verify the exact target context before sending when the target skill requires it
roll run <reader-agent> <open-target-tool> --input-json '{...}' --json

# 5. Send
roll run <reader-agent> <send-tool> --input-json '{...}' --json

# 6. Verify with an independent read
roll run <reader-agent> <read-tool> --input-json '{...}' --json
```

Use this when:
- browser-use-agent reads chat state and sends
- smart-reply-agent generates candidate replies
- message delivery must be confirmed externally

For generated side effects:
- Never batch-send every generated result blindly.
- Parse each generation result first.
- Pass only the minimum opaque artifact required by the sender tool, such as `preparedReplyId`,
  instead of exposing or storing lower-level authorization envelopes in the orchestrator.
- If the generation/preview output includes neutral alternatives such as `replyVariantSelection`,
  follow the target agent's decision ownership. The sender may own the required Judge internally; a
  separate Judge may be optional preview only; or the orchestrator may provide an explicit choice.
  Do not infer hidden labels behind `option_1` / `option_2` style choices.
- Filter out low-confidence, policy-risk, validation-risk, stale-target, or otherwise unsafe results
  before constructing the send batch.
- Do not send provisional draft text or model output directly unless the sender tool explicitly
  allows raw text.
- When a send call returns a confirmation gate, retry the same send with the same routing key,
  prepared artifact, chosen option, reason, and approval object. If any of those fields change, treat
  it as a new send that needs its own confirmation.
- Treat target-opening requirements as agent-specific. For example, a sender tool may validate the
  current target itself and only reopen when the selected target is stale; read that agent's own
  `SKILL.md` before adding explicit open steps.

Batching this pattern:

```text
read batch
  -> orchestrator parse/filter
  -> generate/preview batch
  -> orchestrator parse/filter
  -> optional judge/decision batch
  -> orchestrator parse/filter
  -> side-effect batch
  -> verify batch/read
```

### Example: BOSS Zhipin Prepared Reply

When `browser-use-agent` owns the read/preview/send loop:

```bash
# browser-runtime calls include browserInstance
roll run browser-use-agent zhipin_read_messages \
  --input-json '{"browserInstance":"boss-a","onlyUnread":true,"limit":5}' --json

roll run browser-use-agent zhipin_generate_reply_preview \
  --input-json '{"browserInstance":"boss-a","conversationId":"..."}' --json

# optional preview only; the default send path does not require this call
roll run browser-use-agent zhipin_judge_prepared_reply \
  --input-json '{"preparedReplyId":"..."}' --json

# default path: resume browser-runtime with the same routing key; send owns Judge + feedback closure
roll run browser-use-agent zhipin_send_prepared_reply \
  --input-json '{"browserInstance":"boss-a","preparedReplyId":"..."}' --json

roll run browser-use-agent zhipin_read_messages \
  --input-json '{"browserInstance":"boss-a","onlyUnread":true,"limit":5}' --json
```

Variant-specific rules:

- `zhipin_judge_prepared_reply` is a global/no-runtime helper. Do not add `browserInstance` to its input.
- Keep `preparedReplyId` scoped to the workflow that created it; resume browser-runtime calls with the original `browserInstance`.
- If judge returns `fallback:true`, omit `variantDecision`; the sender uses the recommended draft and submits `not_learned`, closing Pending without adding Beta evidence.
- If orchestrator chooses manually, `variantDecision` must include `chosenOption` (`option_1` or `option_2`) and a concrete audit `reason`; `confirmedFindingCodes` / `judgeModel` remain optional. “Only neutral options” means do not infer hidden draft labels from preview text.
- If send returns `needs_confirmation`, retry the same send with the same `browserInstance`, `preparedReplyId`, `variantDecision`, reason, and approval object returned by the tool.
- Treat `feedbackStatus:"accepted"|"duplicate"` as closed, `queued` as outbox-owned retry, and `failed` as a feedback gap after the candidate message was already sent. Never rerun send to repair feedback.
- `feedbackExpected:false` means no Beta learning; it does not mean the feedback terminal callback is optional.
- The browser-use outbox caps retries at Reply Authority `feedbackExpiresAt`; the orchestrator must not extend the deadline or POST feedback independently.

## Pattern 2: Brand / Tenant / Workspace Switch Before Generation

If the generator depends on mutable shared context (brand data, tenant config, project data), refresh it before generation.

Example shape:

```bash
roll run <generator-agent> <sync-context-tool> --input-json '{"brandAlias":"..."}' --json
roll run <generator-agent> <generate-tool> --input-json '{...}' --json
```

Rules:
- Do not assume a prior sync is still valid after switching brands or tenants.
- If the generator stores only one active context at a time, avoid parallel generation across different brands/tenants.
- Prefer serial batches grouped by brand/tenant.

## Pattern 3: Persistent Browser Recovery

A browser agent may look healthy at the process layer while the page state is broken.

Typical symptoms:
- `roll agent health --json` says healthy
- the browser page is `about:blank`
- reads return empty or false negatives
- page evaluation fails during navigation

Recovery path:

```bash
roll agent health --json
roll run <browser-agent> browser_status --json
roll run <browser-agent> open_platform --input-json '{"platform":"..."}' --json
# then re-run the real read/check tool
```

If the browser agent exposes an account/profile routing key, pass it through every recovery call:

```bash
roll run browser-use-agent browser_status \
  --input-json '{"browserInstance":"boss-a"}' --json
roll run browser-use-agent open_platform \
  --input-json '{"browserInstance":"boss-a","platform":"zhipin"}' --json
```

If the service is healthy but a specific browser runtime/page is stale, close only that runtime:

```bash
roll browser stop boss-a
roll run browser-use-agent open_platform \
  --input-json '{"browserInstance":"boss-a","platform":"zhipin"}' --json
```

Rules:

1. Do not use one browser worker to recover another worker's profile.
2. Do not reuse page ids, element refs, prepared replies, or conversation-local state across different routing keys.
3. When multiple account workers run concurrently, each worker must pin its routing key before the first browser call and keep it unchanged for the whole workflow.
4. Use `roll browser stop --all` only when every currently started browser runtime should be closed while the browser agent service stays available.
5. Use `roll browser clear-data` only for intentional profile/session deletion, after inspecting the dry-run scope.

If the service is still unusable and Roll owns lifecycle:

```bash
roll agent stop <browser-agent>
roll agent start <browser-agent>
roll agent health --json
```

## Pattern 4: Known Tool Over Router

When the exact target agent and tool are already known, prefer:

```bash
roll run <agent> <tool> --input-json '{...}' --json
```

over:

```bash
roll ask "..." --json
```

Use `roll ask` only when routing is still ambiguous.

## Pattern 5: Verify Side Effects Externally

Do not trust success acknowledgements blindly when the target system exposes a separate read path.

Examples:
- after sending a chat reply, re-read unread state or the target thread
- after updating a record, fetch it again
- after creating a task, list/search to confirm it exists in the expected place

A practical rule:
- if the action changes external state, add one read-back step unless the platform guarantees strong confirmation

## Pattern 6: Agent-Provided Refs Over Raw UI Indices

When a reader tool returns both raw UI positions and semantic refs, pass the semantic refs to later
tools.

Use this when:
- a browser/list tool returns refs such as `@e1`, `@c1`, or `@j1` alongside DOM indices
- the list may scroll, filter, refresh, or reorder between steps
- an upstream orchestrator needs to keep a compact handle for the next tool call

Rules:
1. Treat raw `index` as a current-snapshot fallback.
2. Treat agent-provided refs as the preferred handle for follow-up tool calls.
3. Refresh the reader tool before reusing refs after a filter, search, navigation, or page reload.
4. Do not invent refs in orchestrator code; only pass refs emitted by the target agent.
5. Do not mix ref families. A ref emitted by one tool family is only valid for tools documented to consume it.

## Pattern 7: Observe -> Choose Execution Level -> Verify

Use the live target skill and tool schema to choose among these paths:

| Situation | Execution level |
| --- | --- |
| The platform has a purpose-built tool or an enabled workflow that covers the task | Use that tool or workflow with its own validation. |
| The page or next target is unknown, or the orchestrator must decide after one action | Observe, act on one emitted ref, then observe again. |
| Several steps and checks are known without an intermediate orchestrator decision | Use controlled combined execution if the target agent offers it. |
| The target executor can own the full bounded task, including internal observation and recovery | Delegate the complete goal and supplied values, then verify externally. |

For the single-ref path, parse the snapshot result, match intent against the observed role, name,
state, and any documented non-semantic markers, then pass only a ref the target emitted. Include the
page and snapshot IDs when the tool requires or supports strict binding. Re-observe after a mutation
that may change the page before choosing another ref. A truncated or incomplete snapshot calls for
more focused observation, not an assumption that a control is absent.

Combined execution is useful when the target agent can keep one authorized, bounded sequence with
its own observations and assertions. Split it at a point where the orchestrator must interpret new
page data, decide whether to proceed, or seek new authorization. A task executor is appropriate
only when the caller can provide the original goal, required facts or exact text, allowed action
scope, and stopping condition. Preserve goal and text verbatim; its done status remains subject to
external verification.

Across all paths:

1. Prefer domain-specific readback when it represents business state; a generic snapshot is not a
   complete HTML dump, screenshot, or business data model.
2. Keep refs and snapshot IDs scoped to their page, document, routing key, and most recent
   observation. Do not invent refs or rewrite browser-internal frame metadata.
3. Follow the target agent's confirmation flow. Save, send, publish, or submit only within the
   user's authorization. On partial failure or uncertain execution, inspect completed actions and
   current state before resuming; do not replay the whole call.
4. An OpenClaw-style host calling `roll run` receives that call's output. Roll chat's internal
   observation projection and `roll__observation` recall are not automatically available there.

Non-accessible widgets, canvas controls, cross-target iframes, and gestures may need dedicated
target-agent tools. Keep exact tool names and schemas in that agent's own skill and references.

## Pattern 8: State-Setting Tools Are Not Append Operations

Use this pattern when a tool sets filters, tags, labels, memberships, selections, assignees, or any
other target state.

Example shape:

```bash
roll skills get <agent-name> --json
roll agent tools <agent-name> --json
roll run <agent-name> <state-setting-tool> --input-json '{"applyMode":"replace", "...":"..."}' --json
roll run <agent-name> <read-back-tool> --input-json '{...}' --json
```

Rules:

1. Treat array fields according to the target agent's documentation. They may mean exact final set,
   append, toggle, ordered priority, or clear.
2. If a tool exposes `applyMode`, use `replace` when the orchestrator owns the desired final state,
   and `patch` only when leaving unspecified fields untouched is intentional.
3. If the target agent documents sentinel values for clearing a field, pass those values exactly
   instead of omitting the field.
4. Do not reuse stale refs, indices, prepared artifacts, or cached result lists after a state-setting
   tool refreshes the underlying view.
5. Verify the resulting state through a read-back tool or a returned normalized summary before
   chaining dependent actions.

## Common Pitfalls

### 1. Process healthy != page healthy
A persistent browser agent can be healthy while the actual page is broken or navigated away.

### 2. Tool success != business success
A send/update tool may return success while the external system did not persist the action. Re-read externally.

### 3. Parallel generation can leak shared mutable context
If a generator uses a mutable shared context file or last-synced brand/tenant state, parallel runs across contexts can cross-contaminate outputs.

### 4. Reader and sender may need an explicit target-open step
Do not assume the sender is still focused on the same target the reader inspected earlier.

### 5. UI index != stable business identity
Raw list indices are only valid for the latest page snapshot. Prefer IDs or refs emitted by the
reader tool.

### 6. Generic element ref != business identity
Refs such as `@e1` point to current page elements. They are appropriate for click/type actions, but
they should not be stored as candidate, job, account, or conversation identity.

## Boundary Of This File

This file intentionally does **not** define:
- target agent tool schemas
- business-domain prompts
- per-agent env variables
- per-agent capability details

Read each target subagent's own `SKILL.md` or runtime metadata for those details.
