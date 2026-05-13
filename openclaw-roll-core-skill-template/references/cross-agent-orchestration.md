# Cross-Agent Orchestration Patterns

Use this file for shared sequencing patterns that only appear when multiple Roll agents cooperate. Keep agent-specific tool schemas in each target agent's own `SKILL.md`.

## Core Principle

Prefer explicit, verifiable chains over optimistic single-shot automation.

When multiple agents cooperate:
1. Verify the upstream agent/runtime state first.
2. Refresh shared context before generation when the target brand / tenant / workspace changes.
3. Pass only the minimum validated output from one agent into the next.
4. Add an external verification step after side effects (send, write, create, update).

## Pattern 1: Read -> Generate -> Send -> Verify

Use this pattern when one agent reads state, another generates content, and the first agent sends it.

Example shape:

```bash
# 1. Read latest state
roll run <reader-agent> <read-tool> --input-json '{...}' --json

# 2. Generate response from validated input
roll run <generator-agent> <generate-tool> --input-json '{...}' --json

# 3. Prepare or verify the exact target context before sending when the target skill requires it
roll run <reader-agent> <open-target-tool> --input-json '{...}' --json

# 4. Send
roll run <reader-agent> <send-tool> --input-json '{...}' --json

# 5. Verify with an independent read
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
- Filter out low-confidence, policy-risk, validation-risk, stale-target, or otherwise unsafe results
  before constructing the send batch.
- Do not send provisional draft text or model output directly unless the sender tool explicitly
  allows raw text.
- Treat target-opening requirements as agent-specific. For example, a sender tool may validate the
  current target itself and only reopen when the selected target is stale; read that agent's own
  `SKILL.md` before adding explicit open steps.

Batching this pattern:

```text
read batch
  -> orchestrator parse/filter
  -> generate batch
  -> orchestrator parse/filter
  -> side-effect batch
  -> verify batch/read
```

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

If the service is still unusable and Roll owns lifecycle:

```bash
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
- a browser/list tool returns refs such as `@c1` alongside DOM indices
- the list may scroll, filter, refresh, or reorder between steps
- an upstream orchestrator needs to keep a compact handle for the next tool call

Rules:
1. Treat raw `index` as a current-snapshot fallback.
2. Treat agent-provided refs as the preferred handle for follow-up tool calls.
3. Refresh the reader tool before reusing refs after a filter, search, navigation, or page reload.
4. Do not invent refs in orchestrator code; only pass refs emitted by the target agent.

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

## Boundary Of This File

This file intentionally does **not** define:
- target agent tool schemas
- business-domain prompts
- per-agent env variables
- per-agent capability details

Read each target subagent's own `SKILL.md` or runtime metadata for those details.
