import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  RUNTIME_SERVER_REQUEST_METHODS,
  approvalRequestParamsV11Schema,
  approvalRequestParamsV12Schema,
  interactionIdSchema,
  threadIdSchema,
  turnIdSchema,
  userInputRequestParamsV12Schema,
  type ApprovalRequestResult,
  type UserInputResult,
} from "@roll-agent/protocol";
import {
  RELAY_INTERACTION_METHODS_V11,
  relayApprovalCandidateParamsSchema,
  relayInteractionCandidateParamsSchemaV11,
  relayRequestIdSchema,
  workspaceIdSchema,
  type RelayInteractionCandidateParamsV11,
} from "@roll-agent/relay-protocol";
import {
  CompanionInteractionBroker,
  createRuntimeServerRequestHandlers,
  type CompanionInteractionFrameDraftV11,
  type RemoteInteractionCandidateContext,
} from "./interaction-broker.ts";
import type { LocalApprovalPolicy } from "./companion-workspace.ts";

const IDS = {
  thread: "00000000-0000-4000-8000-000000001001",
  turn: "00000000-0000-4000-8000-000000001002",
  otherTurn: "00000000-0000-4000-8000-000000001003",
  approval: "00000000-0000-4000-8000-000000001004",
  interaction: "00000000-0000-4000-8000-000000001005",
  secondInteraction: "00000000-0000-4000-8000-000000001006",
  legacyInteraction: "00000000-0000-4000-8000-000000001007",
  workspace: "00000000-0000-4000-8000-000000001008",
  otherWorkspace: "00000000-0000-4000-8000-000000001009",
  relayRequest: "00000000-0000-4000-8000-000000001010",
  secondRelayRequest: "00000000-0000-4000-8000-000000001011",
} as const;

const FUTURE = "2099-08-04T12:05:00.000Z";
const threadId = threadIdSchema.parse(IDS.thread);
const turnId = turnIdSchema.parse(IDS.turn);
const workspaceId = workspaceIdSchema.parse(IDS.workspace);

type InteractionRequestDraft = Extract<
  CompanionInteractionFrameDraftV11,
  { readonly type: "interaction.request" }
>;

function approvalParams(interactionId = IDS.interaction) {
  return approvalRequestParamsV12Schema.parse({
    interactionId,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: FUTURE,
    sensitivity: "normal",
    approval: {
      id: IDS.approval,
      turnId: IDS.turn,
      agentName: "deploy-agent",
      toolName: "deploy",
      preview: {
        explanation: "部署需要确认",
        rawToolInput: "SECRET_RAW_TOOL_INPUT_SENTINEL",
        token: "SECRET_TOKEN_SENTINEL",
      },
      reason: "SECRET_LOCAL_POLICY_REASON_SENTINEL",
    },
  });
}

function userInputParams(expiresAt = FUTURE) {
  return userInputRequestParamsV12Schema.parse({
    interactionId: IDS.secondInteraction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt,
    sensitivity: "normal",
    title: "部署选项",
    description: "请选择部署区域和目标 Workspace",
    controls: [
      {
        id: "region",
        type: "choice",
        label: "部署区域",
        required: true,
        multiple: false,
        options: [
          { id: "east", label: "East" },
          { id: "west", label: "West" },
        ],
      },
      {
        id: "workspace",
        type: "text",
        label: "目标 Workspace",
        required: true,
      },
    ],
  });
}

function candidateContext(
  overrides: Partial<RemoteInteractionCandidateContext> = {},
): RemoteInteractionCandidateContext {
  return {
    workspaceId,
    requestId: relayRequestIdSchema.parse(IDS.relayRequest),
    signal: new AbortController().signal,
    responderPolicy: () => true,
    responderContext: { session: "OPAQUE_SESSION_SENTINEL" },
    ...overrides,
  };
}

function approvalCandidate(decision: "approve" | "reject" = "approve") {
  return relayInteractionCandidateParamsSchemaV11.parse({
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
    candidate: {
      decision,
      ...(decision === "reject" ? { reason: "remote rejected" } : {}),
    },
  });
}

function userInputCandidate(values: readonly { readonly id: string; readonly value: string }[]) {
  return relayInteractionCandidateParamsSchemaV11.parse({
    interactionId: IDS.secondInteraction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
    candidate: { status: "submitted", values },
  });
}

function createBoundBroker(policy: LocalApprovalPolicy = () => "allow") {
  const frames: CompanionInteractionFrameDraftV11[] = [];
  const broker = new CompanionInteractionBroker();
  const release = broker.bindWorkspace({
    workspaceId,
    localApprovalPolicy: policy,
    publish: (frame) => frames.push(frame),
  });
  return { broker, frames, release };
}

function requestFrames(
  frames: readonly CompanionInteractionFrameDraftV11[],
): readonly InteractionRequestDraft[] {
  return frames.filter(
    (frame): frame is InteractionRequestDraft => frame.type === "interaction.request",
  );
}

function runtimeContext(controller = new AbortController()) {
  return {
    controller,
    context: {
      requestId: "SECRET_RUNTIME_JSON_RPC_ID_SENTINEL",
      signal: controller.signal,
    },
  };
}

test("approval request publishes only the safe projection and allow resolves exactly once", async () => {
  let localPolicyCalls = 0;
  const { broker, frames } = createBoundBroker(() => {
    localPolicyCalls += 1;
    return "allow";
  });
  const handlers = createRuntimeServerRequestHandlers(broker);
  assert.deepEqual(Object.keys(handlers).sort(), ["approval.request", "userInput.request"]);
  const handle = handlers[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
  assert.ok(handle);
  const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    type: "interaction.request",
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: FUTURE,
    sensitivity: "normal",
    method: "approval.request",
    projection: {
      approvalId: IDS.approval,
      agentName: "deploy-agent",
      toolName: "deploy",
      explanation: "部署需要确认",
    },
  });
  const serialized = JSON.stringify(frames);
  for (const sentinel of [
    "SECRET_RAW_TOOL_INPUT_SENTINEL",
    "SECRET_TOKEN_SENTINEL",
    "SECRET_LOCAL_POLICY_REASON_SENTINEL",
    "SECRET_RUNTIME_JSON_RPC_ID_SENTINEL",
    "OPAQUE_SESSION_SENTINEL",
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.equal("workspaceId" in (frames[0] ?? {}), false);
  assert.equal("relaySequence" in (frames[0] ?? {}), false);

  assert.deepEqual(await broker.submitCandidate(approvalCandidate(), candidateContext()), {
    accepted: true,
  });
  assert.deepEqual(await runtimeResult, { decision: "approve" });
  assert.equal(localPolicyCalls, 1);
  assert.deepEqual(frames.at(-1), {
    type: "interaction.resolved",
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: "approval.request",
  });
  assert.equal(JSON.stringify(frames).includes('"decision":"approve"'), false);
  await assert.rejects(
    broker.submitCandidate(approvalCandidate(), candidateContext()),
    /no longer pending/u,
  );
});

test("approval deny, local confirmation, and remote reject retain fail-closed semantics", async (t) => {
  await t.test("local deny resolves Runtime as reject and rejects the remote approve", async () => {
    const { broker } = createBoundBroker(() => "deny");
    const handle =
      createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
    assert.ok(handle);
    const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));
    await assert.rejects(broker.submitCandidate(approvalCandidate(), candidateContext()), {
      name: "LocalApprovalDeniedError",
    });
    assert.deepEqual(await runtimeResult, {
      decision: "reject",
      reason: "Local Companion policy denied remote approval",
    });
  });

  await t.test(
    "local confirmation rejects only the candidate and leaves interaction pending",
    async () => {
      const { broker } = createBoundBroker(() => "require-local-confirmation");
      const handle =
        createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
      assert.ok(handle);
      const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));
      await assert.rejects(broker.submitCandidate(approvalCandidate(), candidateContext()), {
        name: "LocalConfirmationRequiredError",
      });
      const reject = approvalCandidate("reject");
      assert.deepEqual(
        await broker.submitCandidate(
          reject,
          candidateContext({
            requestId: relayRequestIdSchema.parse(IDS.secondRelayRequest),
          }),
        ),
        { accepted: true },
      );
      assert.deepEqual(await runtimeResult, { decision: "reject", reason: "remote rejected" });
    },
  );

  await t.test("remote reject never invokes the local approval policy", async () => {
    let calls = 0;
    const { broker } = createBoundBroker(() => {
      calls += 1;
      return "allow";
    });
    const handle =
      createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
    assert.ok(handle);
    const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));
    await broker.submitCandidate(approvalCandidate("reject"), candidateContext());
    assert.deepEqual(await runtimeResult, { decision: "reject", reason: "remote rejected" });
    assert.equal(calls, 0);
  });
});

test("user input is method-validated against the original form and normalized by control order", async () => {
  const { broker, frames } = createBoundBroker();
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.userInputRequest];
  assert.ok(handle);
  const runtimeResult = Promise.resolve(handle(userInputParams(), runtimeContext().context));
  assert.equal(broker.leases.has({ kind: "turn", id: IDS.turn }), true);
  const request = requestFrames(frames)[0];
  assert.equal(request?.method, "userInput.request");
  assert.deepEqual(request?.projection, {
    title: "部署选项",
    description: "请选择部署区域和目标 Workspace",
    controls: userInputParams().controls,
  });

  let responderCalls = 0;
  const malformed = {
    interactionId: IDS.secondInteraction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: "userInput.request",
    candidate: {
      status: "submitted",
      values: [
        { id: "region", value: "unknown" },
        { id: "workspace", value: "prod" },
      ],
    },
  } as RelayInteractionCandidateParamsV11;
  await assert.rejects(
    broker.submitCandidate(
      malformed,
      candidateContext({
        responderPolicy: () => {
          responderCalls += 1;
          return true;
        },
      }),
    ),
  );
  assert.equal(responderCalls, 1, "responder policy runs before method-specific validation");

  await broker.submitCandidate(
    userInputCandidate([
      { id: "workspace", value: "prod" },
      { id: "region", value: "west" },
    ]),
    candidateContext({ requestId: relayRequestIdSchema.parse(IDS.secondRelayRequest) }),
  );
  assert.deepEqual(await runtimeResult, {
    status: "submitted",
    values: [
      { id: "region", value: "west" },
      { id: "workspace", value: "prod" },
    ],
  });
  assert.equal(broker.leases.has({ kind: "turn", id: IDS.turn }), false);
  assert.equal(JSON.stringify(frames).includes('"values"'), false);
});

test("identity and responder policy are checked without cancelling a valid pending interaction", async () => {
  const { broker } = createBoundBroker();
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
  assert.ok(handle);
  const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));
  let responderCalls = 0;
  const wrongIdentity = {
    ...approvalCandidate(),
    turnId: turnIdSchema.parse(IDS.otherTurn),
  };
  await assert.rejects(
    broker.submitCandidate(
      wrongIdentity,
      candidateContext({
        responderPolicy: () => {
          responderCalls += 1;
          return true;
        },
      }),
    ),
    /does not match/u,
  );
  assert.equal(responderCalls, 0);
  await assert.rejects(
    broker.submitCandidate(
      approvalCandidate(),
      candidateContext({
        workspaceId: workspaceIdSchema.parse(IDS.otherWorkspace),
        responderPolicy: () => {
          responderCalls += 1;
          return true;
        },
      }),
    ),
    /another workspace/u,
  );
  assert.equal(responderCalls, 0);
  await assert.rejects(
    broker.submitCandidate(approvalCandidate(), candidateContext({ responderPolicy: () => false })),
    /policy denied/u,
  );
  await broker.submitCandidate(
    approvalCandidate("reject"),
    candidateContext({ requestId: relayRequestIdSchema.parse(IDS.secondRelayRequest) }),
  );
  assert.deepEqual(await runtimeResult, { decision: "reject", reason: "remote rejected" });
});

test("runtime abort, terminal turn, deadline, release, and close share one cancellation finish", async (t) => {
  async function assertCancelledBy(
    finish: (
      broker: CompanionInteractionBroker,
      controller: AbortController,
      release: () => void,
    ) => void | Promise<void>,
    expiresAt = FUTURE,
  ): Promise<void> {
    const { broker, frames, release } = createBoundBroker();
    const { controller, context } = runtimeContext();
    const handle =
      createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.userInputRequest];
    assert.ok(handle);
    const runtimeResult = Promise.resolve(handle(userInputParams(expiresAt), context));
    const rejected = assert.rejects(runtimeResult);
    await finish(broker, controller, release);
    await rejected;
    assert.equal(frames.filter((frame) => frame.type === "interaction.cancelled").length, 1);
    assert.equal(frames.filter((frame) => frame.type === "interaction.resolved").length, 0);
    release();
    broker.close();
  }

  await t.test("Runtime abort", () =>
    assertCancelledBy((_broker, controller) => controller.abort(new Error("runtime abort"))),
  );
  await t.test("turn terminal", () =>
    assertCancelledBy((broker) => {
      assert.equal(broker.cancelTurn(threadId, turnId, "turn completed"), 1);
      assert.equal(broker.cancelTurn(threadId, turnId, "duplicate"), 0);
    }),
  );
  await t.test("deadline", () =>
    assertCancelledBy(async () => delay(50), new Date(Date.now() + 20).toISOString()),
  );
  await t.test("workspace release", () =>
    assertCancelledBy((_broker, _controller, release) => release()),
  );
  await t.test("broker close", () => assertCancelledBy((broker) => broker.close("shutdown")));
});

test(
  "terminal finishes abort a candidate that is blocked in responder policy",
  { timeout: 2_000 },
  async (t) => {
    async function assertCandidateAbortedBy(
      finish: (
        broker: CompanionInteractionBroker,
        runtimeController: AbortController,
        release: () => void,
      ) => void | Promise<void>,
      expiresAt = FUTURE,
    ): Promise<void> {
      const { broker, release } = createBoundBroker();
      const { controller, context: runtimeRequestContext } = runtimeContext();
      const handle =
        createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
      assert.ok(handle);
      const params = approvalRequestParamsV12Schema.parse({
        ...approvalParams(),
        expiresAt,
      });
      const runtimeResult = Promise.resolve(handle(params, runtimeRequestContext));
      const responderSignals: AbortSignal[] = [];
      const candidate = broker.submitCandidate(
        approvalCandidate(),
        candidateContext({
          responderPolicy: ({ signal }) => {
            responderSignals.push(signal);
            return new Promise<boolean>(() => {});
          },
        }),
      );
      const contender = broker.submitCandidate(
        approvalCandidate("reject"),
        candidateContext({
          requestId: relayRequestIdSchema.parse(IDS.secondRelayRequest),
          responderPolicy: ({ signal }) => {
            responderSignals.push(signal);
            return new Promise<boolean>(() => {});
          },
        }),
      );
      const runtimeRejected = assert.rejects(runtimeResult);
      const candidateRejected = assert.rejects(candidate);
      const contenderRejected = assert.rejects(contender);
      await finish(broker, controller, release);
      await Promise.all([runtimeRejected, candidateRejected, contenderRejected]);
      assert.equal(responderSignals.length, 2);
      assert.equal(
        responderSignals.every((signal) => signal.aborted),
        true,
      );
      release();
      broker.close();
    }

    await t.test("Runtime abort", () =>
      assertCandidateAbortedBy((_broker, controller) =>
        controller.abort(new Error("Runtime aborted")),
      ),
    );
    await t.test("turn terminal", () =>
      assertCandidateAbortedBy((broker) => {
        assert.equal(broker.cancelTurn(threadId, turnId, "turn terminal"), 1);
      }),
    );
    await t.test("deadline", () =>
      assertCandidateAbortedBy(async () => delay(40), new Date(Date.now() + 20).toISOString()),
    );
    await t.test("workspace release", () =>
      assertCandidateAbortedBy((_broker, _controller, release) => release()),
    );
    await t.test("broker close", () =>
      assertCandidateAbortedBy((broker) => broker.close("bridge closed")),
    );
  },
);

test("duplicate candidates coalesce, late candidates fail, and rejection wins an active approve", async () => {
  const responder = Promise.withResolvers<boolean>();
  let responderCalls = 0;
  const { broker, frames } = createBoundBroker();
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
  assert.ok(handle);
  const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));
  const context = candidateContext({
    responderPolicy: () => {
      responderCalls += 1;
      return responder.promise;
    },
  });
  const first = broker.submitCandidate(approvalCandidate(), context);
  const duplicate = broker.submitCandidate(approvalCandidate(), context);
  responder.resolve(true);
  assert.deepEqual(await first, { accepted: true });
  assert.deepEqual(await duplicate, { accepted: true });
  assert.equal(responderCalls, 1);
  assert.deepEqual(await runtimeResult, { decision: "approve" });
  assert.equal(frames.filter((frame) => frame.type === "interaction.resolved").length, 1);
  await assert.rejects(broker.submitCandidate(approvalCandidate(), context), /no longer pending/u);

  const gate = Promise.withResolvers<boolean>();
  const second = createBoundBroker();
  const secondHandle = createRuntimeServerRequestHandlers(second.broker)[
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  ];
  assert.ok(secondHandle);
  const secondRuntime = Promise.resolve(secondHandle(approvalParams(), runtimeContext().context));
  const approving = second.broker.submitCandidate(
    approvalCandidate(),
    candidateContext({ responderPolicy: () => gate.promise }),
  );
  await second.broker.submitCandidate(
    approvalCandidate("reject"),
    candidateContext({ requestId: relayRequestIdSchema.parse(IDS.secondRelayRequest) }),
  );
  await assert.rejects(
    Promise.race([
      approving,
      delay(100).then(() => {
        throw new Error("superseded approval candidate did not abort");
      }),
    ]),
    /superseded/u,
  );
  gate.resolve(true);
  assert.deepEqual(await secondRuntime, { decision: "reject", reason: "remote rejected" });
  assert.equal(second.frames.filter((frame) => frame.type === "interaction.resolved").length, 1);
});

test("stale generation aborts only its candidate attempt and ignores late async policy output", async () => {
  const responder = Promise.withResolvers<boolean>();
  const generation = new AbortController();
  const { broker, frames } = createBoundBroker();
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
  assert.ok(handle);
  const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));
  const stale = broker.submitCandidate(
    approvalCandidate(),
    candidateContext({
      signal: generation.signal,
      responderPolicy: () => responder.promise,
    }),
  );
  generation.abort(new Error("old generation"));
  await assert.rejects(stale, /old generation/u);
  responder.resolve(true);
  await delay(0);
  assert.equal(frames.length, 1, "late result from the old generation cannot settle Runtime");

  await broker.submitCandidate(
    approvalCandidate(),
    candidateContext({ requestId: relayRequestIdSchema.parse(IDS.secondRelayRequest) }),
  );
  assert.deepEqual(await runtimeResult, { decision: "approve" });
});

test("legacy Wire 1.0 approval maps approvalId without reusing it as InteractionId", async () => {
  let localPolicyCalls = 0;
  const frames: CompanionInteractionFrameDraftV11[] = [];
  const broker = new CompanionInteractionBroker({
    createInteractionId: () => interactionIdSchema.parse(IDS.legacyInteraction),
  });
  broker.bindWorkspace({
    workspaceId,
    localApprovalPolicy: () => {
      localPolicyCalls += 1;
      return "allow";
    },
    publish: (frame) => frames.push(frame),
  });
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
  assert.ok(handle);
  const params = approvalRequestParamsV11Schema.parse({
    threadId: IDS.thread,
    approval: approvalParams().approval,
  });
  const runtimeResult = Promise.resolve(handle(params, runtimeContext().context));
  assert.equal(requestFrames(frames)[0]?.interactionId, IDS.legacyInteraction);
  assert.notEqual(requestFrames(frames)[0]?.interactionId, IDS.approval);
  assert.deepEqual(
    await broker.submitLegacyApprovalCandidate(
      relayApprovalCandidateParamsSchema.parse({
        threadId: IDS.thread,
        turnId: IDS.turn,
        approvalId: IDS.approval,
        decision: "approve",
      }),
    ),
    { accepted: true },
  );
  assert.deepEqual(await runtimeResult, { decision: "approve" } satisfies ApprovalRequestResult);
  assert.equal(localPolicyCalls, 1);
});

test("publish failure rolls back registration and rejects Runtime without a fake terminal frame", async () => {
  const broker = new CompanionInteractionBroker();
  broker.bindWorkspace({
    workspaceId,
    localApprovalPolicy: () => "allow",
    publish: () => {
      throw new Error("buffer unavailable");
    },
  });
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.userInputRequest];
  assert.ok(handle);
  await assert.rejects(
    Promise.resolve(handle(userInputParams(), runtimeContext().context)),
    /buffer unavailable/u,
  );
  await assert.rejects(
    broker.submitCandidate(
      userInputCandidate([{ id: "region", value: "east" }]),
      candidateContext(),
    ),
    /no longer pending/u,
  );
  broker.close();
});

test("cancelTurn accepts branded identities and does not cross turn boundaries", async () => {
  const { broker } = createBoundBroker();
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
  assert.ok(handle);
  const runtimeResult = Promise.resolve(handle(approvalParams(), runtimeContext().context));
  assert.equal(broker.cancelTurn(threadId, turnIdSchema.parse(IDS.otherTurn), "wrong turn"), 0);
  assert.equal(broker.cancelTurn(threadId, turnId, "right turn"), 1);
  await assert.rejects(runtimeResult);
});

test("user input cancellation remains a result and is not projected to Relay", async () => {
  const { broker, frames } = createBoundBroker();
  const handle =
    createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.userInputRequest];
  assert.ok(handle);
  const runtimeResult = Promise.resolve(handle(userInputParams(), runtimeContext().context));
  const candidate = relayInteractionCandidateParamsSchemaV11.parse({
    interactionId: IDS.secondInteraction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: "userInput.request",
    candidate: { status: "cancelled", reason: "user pressed Escape" },
  });
  await broker.submitCandidate(candidate, candidateContext());
  assert.deepEqual(await runtimeResult, {
    status: "cancelled",
    reason: "user pressed Escape",
  } satisfies UserInputResult);
  assert.equal(JSON.stringify(frames).includes("user pressed Escape"), false);
});
