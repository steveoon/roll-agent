import assert from "node:assert/strict";
import test from "node:test";
import {
  RELAY_REQUEST_METHODS_V11,
  relayInteractionCandidateParamsSchemaV11,
  relayRequestIdSchema,
  workspaceIdSchema,
} from "@roll-agent/relay-protocol";
import {
  P0_REMOTE_REQUEST_METHODS,
  createOfficialRelayResponderContext,
  createOfficialRelayResponderPolicy,
  createP0RemoteRequestPolicy,
} from "./policy.ts";

const workspaceId = workspaceIdSchema.parse("11111111-1111-4111-8111-111111111111");
const requestId = relayRequestIdSchema.parse("22222222-2222-4222-8222-222222222222");
const candidateIdentity = relayInteractionCandidateParamsSchemaV11.parse({
  interactionId: "44444444-4444-4444-8444-444444444444",
  threadId: "55555555-5555-4555-8555-555555555555",
  turnId: "66666666-6666-4666-8666-666666666666",
  method: "approval.request",
  candidate: { decision: "approve" },
});

test("P0 request policy admits only the bound workspace allowlist", async () => {
  const policy = createP0RemoteRequestPolicy(workspaceId);
  for (const method of P0_REMOTE_REQUEST_METHODS) {
    assert.equal(
      await policy({
        workspaceId,
        requestId,
        method,
        responderContext: null,
        signal: new AbortController().signal,
      }),
      true,
    );
  }
  assert.equal(
    await policy({
      workspaceId,
      requestId,
      method: RELAY_REQUEST_METHODS_V11.threadDelete,
      responderContext: null,
      signal: new AbortController().signal,
    }),
    false,
  );
  assert.equal(
    await policy({
      workspaceId: workspaceIdSchema.parse("33333333-3333-4333-8333-333333333333"),
      requestId,
      method: RELAY_REQUEST_METHODS_V11.threadList,
      responderContext: null,
      signal: new AbortController().signal,
    }),
    false,
  );
});

test("P0 request and responder policies fail closed after generation abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const requestPolicy = createP0RemoteRequestPolicy(workspaceId);
  assert.equal(
    await requestPolicy({
      workspaceId,
      requestId,
      method: RELAY_REQUEST_METHODS_V11.threadList,
      responderContext: null,
      signal: controller.signal,
    }),
    false,
  );

  const responderPolicy = createOfficialRelayResponderPolicy(workspaceId);
  assert.equal(
    await responderPolicy({
      workspaceId,
      requestId,
      interactionId: candidateIdentity.interactionId,
      threadId: candidateIdentity.threadId,
      turnId: candidateIdentity.turnId,
      method: candidateIdentity.method,
      responderContext: createOfficialRelayResponderContext(),
      signal: controller.signal,
    }),
    false,
  );
});
