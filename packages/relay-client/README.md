# `@roll-agent/relay-client`

Browser-safe client for connecting a Web application to a user's enrolled Roll Workspace through
the official Cloud Relay. It owns Control 1.0 and Relay Wire 1.1 framing, request correlation,
reconnection, ACK/gap recovery, and the Chat/Interaction reducer.

The package does not contain React components, account management, a Relay admin client, or a raw
frame API.

The separate `roll-cloud-relay` repository must implement the Browser Session and WSS contracts
before this path can be used in production; its current implementation has not yet been updated to
these contracts.

## Install

```bash
pnpm add @roll-agent/relay-client
```

Your application backend must exchange its authenticated user for a short-lived, single-use Relay
Browser session. Relay credentials must never be returned to Browser code.

```ts
import { createRelayClient } from "@roll-agent/relay-client";

const client = createRelayClient({
  getSession: async ({ signal }) => {
    const response = await fetch("/api/roll/session", {
      method: "POST",
      credentials: "include",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Session request failed: ${response.status}`);
    }
    return response.json(); // Validated as { connectUrl: "wss://...", expiresAt: ISO timestamp }.
  },
});

await client.connect();
const thread = await client.createThread({ title: "Support task" });

const unsubscribe = thread.subscribe((view) => {
  renderChat(view.snapshot, view.liveAssistantMessages, view.interactions);
});

await thread.send("Check this workspace and summarize the project.");
```

`workspaceId`, Relay request IDs, Runtime mutation request IDs, Turn IDs, Wire frames, ACKs, and
session refresh are internal. A normal Web application only renders `RelayThreadView` and invokes
the typed methods.

## Public API

- `client.connect()` / `client.close()`
- `client.getConnectionState()` / `client.subscribeConnection(listener)`
- `client.listThreads()` / `client.createThread()` / `client.openThread(threadId)`
- `thread.getSnapshot()` / `thread.subscribe(listener)`
- `thread.send(text)` / `thread.cancel(turnId)`
- `thread.respond(interactionId, candidate)` / `thread.refresh()`

All requests support an optional `AbortSignal` and timeout. If a mutation was sent but its response
cannot be observed, the client rejects with a typed `RelayClientError` whose code is
`OUTCOME_UNKNOWN`. The application should refresh the Thread snapshot instead of automatically
creating a new mutation.

`createThread()` also protects this boundary: once `thread.create` succeeds, a failure to hydrate its
first snapshot does not reject the already-completed creation. It returns a Thread whose view is in
the `error` state; call `thread.refresh()` to converge without creating a second Thread.

## Recovery semantics

The client applies event and Interaction frames only in contiguous `relaySequence` order and emits
Wire 1.1 `runtime.ack` for the highest sequence already applied. A Relay gap, or a locally observed
sequence hole, triggers `thread.snapshot` recovery before the recovery boundary is acknowledged.

An in-flight mutation remains in memory across a same-page reconnect and is sent again with the
same Relay request ID and Runtime mutation request ID. Cloud Relay and Companion are responsible for
idempotent replay. A full page refresh intentionally loses this process-local replay state: the old
Promise no longer exists, the new client never guesses or replays that mutation, and the application
must reopen the Thread and converge from its snapshot. `OUTCOME_UNKNOWN` applies while the original
client instance is still alive but can no longer confirm a sent mutation's result.

Wire 1.1 snapshots do not contain a respondable `interactionId` for pending Approval or User Input.
The client never invents one from `pendingApprovals`. On a fresh Browser session, Cloud Relay must
re-deliver outstanding `interaction.request` frames; until that happens the snapshot is state-only
and cannot be remotely answered.

## Interaction lifecycle

`view.interactions` is a discriminated union with `pending`, `responding`, `resolved`, and
`cancelled` states. Pass the `interactionId` from a pending request back to `thread.respond()`. The
candidate is validated against the original Approval or User Input projection before it is sent.

Runtime policy remains authoritative: Runtime `deny` creates no remotely answerable Interaction,
while Runtime `confirm` produces an authenticated Web Interaction. A Host denial is exposed as the
stable remote code `REMOTE_REQUEST_DENIED`; local policy details are not copied into the Browser
error.

## Testing

`@roll-agent/relay-client/testing` exports `createRelayClientForTesting()` and the minimal WebSocket
and scheduler interfaces. Inject a deterministic transport without adding Node APIs to production
Browser code.
