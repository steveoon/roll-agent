import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { test, type TestContext } from "node:test";
import { RollRpcError } from "@roll-agent/client-node";
import {
  threadIdSchema,
  threadModelStatusV17Schema,
  type LatestRuntimeMethodInput,
} from "@roll-agent/protocol";
import {
  RELAY_ERROR_CODES,
  RELAY_ERROR_CODES_V11,
  RELAY_ERROR_CODES_V14,
  deviceIdSchema,
  workspaceIdSchema,
} from "@roll-agent/relay-protocol";
import { CompanionWorkspace, type CompanionRuntimeClient } from "./companion-workspace.ts";
import { CompanionInteractionBroker } from "./interaction-broker.ts";
import { CompanionRelayBridgeV11, type RelayTransportV11 } from "./relay-bridge-v11.ts";

const workspaceId = workspaceIdSchema.parse(randomUUID());
const threadId = threadIdSchema.parse(randomUUID());
const deviceId = deviceIdSchema.parse(randomUUID());
const revision = randomUUID();
const pairingToken = "pairing-token-at-least-sixteen";
const model = {
  provider: "google",
  model: "gemini-4-neon",
  effortCapability: { kind: "levels", levels: ["low", "medium", "high", "xhigh"] },
};
const setParams = {
  threadId,
  requestId: randomUUID(),
  expectedRevision: revision,
  configRevision: "cfg-1",
  effort: { mode: "explicit", level: "high" },
} as const;

function runtimeStatus(level: "medium" | "high", revision: string) {
  return threadModelStatusV17Schema.parse({
    threadId,
    revision,
    configRevision: setParams.configRevision,
    selection: { mode: "default" },
    effort: level === "high" ? setParams.effort : { mode: "default" },
    status: "applied",
    active: { ...model, reasoning: "summary", effort: level, contextWindow: 200_000 },
    target: { ...model, effectiveEffort: level },
  });
}

async function connectBridge(
  t: TestContext,
  protocolVersion: "1.2" | "1.3" | "1.4",
  client: CompanionRuntimeClient,
) {
  const workspace = new CompanionWorkspace({
    client,
    workspaceId,
    localApprovalPolicy: () => "allow",
    interactionBroker: new CompanionInteractionBroker(),
  });
  const bridge = new CompanionRelayBridgeV11({
    deviceId,
    pairingToken,
    protocolVersion,
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const wire = new EventEmitter();
  type Message = Parameters<RelayTransportV11["send"]>[0];
  const outbound: Message[] = [];
  const ready = once(wire, "device.connect", { signal: AbortSignal.timeout(3000) });
  bridge.connect(
    {
      send(frame) {
        outbound.push(frame);
        if (frame.type === "runtime.response") wire.emit(frame.requestId);
        if (frame.type === "device.connect") wire.emit(frame.type);
      },
      onMessage(listener) {
        wire.on("request", listener);
        return () => wire.off("request", listener);
      },
      onClose(listener) {
        wire.on("close", listener);
        return () => wire.off("close", listener);
      },
      close() {
        wire.emit("close");
      },
    },
    {
      requestPolicy: (req) => req.workspaceId === workspaceId,
      responderPolicy: () => true,
      responderContext: {},
    },
  );
  t.after(async () => {
    bridge.close();
    await workspace.closeIfIdle();
  });
  await ready;
  assert.deepEqual(outbound[0], {
    type: "device.connect",
    protocolVersion,
    deviceId,
    pairingToken,
  });
  function frame(
    method: "thread.effort.get" | "thread.effort.set",
    params: unknown,
    target = workspaceId,
  ) {
    return {
      type: "runtime.request",
      requestId: randomUUID(),
      workspaceId: target,
      method,
      params,
    };
  }
  const inject = (request: ReturnType<typeof frame>) => wire.emit("request", request);
  async function exchange(request: ReturnType<typeof frame>) {
    const sent = once(wire, request.requestId, { signal: AbortSignal.timeout(3000) });
    inject(request);
    await sent;
    const response = outbound.find(
      (m) => m.type === "runtime.response" && m.requestId === request.requestId,
    );
    assert.ok(response?.type === "runtime.response");
    return response;
  }
  return { frame, inject, exchange, outbound };
}

const unusedClientMethods = {
  request: async () => {
    throw new Error("unexpected legacy request");
  },
  onEvent: () => () => {},
  close: () => {},
};

test("Wire 1.4 projects effort and preserves mutation IDs across bridge retries", async (t) => {
  const setCalls: Array<LatestRuntimeMethodInput<"thread.model.set">> = [];
  const updatedRevision = randomUUID();
  let reads = 0;
  const wire = await connectBridge(t, "1.4", {
    ...unusedClientMethods,
    getInitializationResult: () => ({ protocolVersion: "1.7" }),
    getThreadModel: async () => {
      reads++;
      return runtimeStatus("medium", revision);
    },
    setThreadModel: async (params) => {
      setCalls.push(params);
      return runtimeStatus("high", updatedRevision);
    },
  });

  const status = (await wire.exchange(wire.frame("thread.effort.get", { threadId }))).result;
  assert.ok(typeof status === "object" && status !== null && "active" in status);
  assert.ok(!("selection" in status));
  assert.deepEqual(status.active, { ...model, reasoning: "summary", effort: "medium" });

  const denied = await wire.exchange(
    wire.frame("thread.effort.get", { threadId }, workspaceIdSchema.parse(randomUUID())),
  );
  assert.equal(denied.error?.code, RELAY_ERROR_CODES_V11.remoteRequestDenied);
  assert.equal(reads, 1);

  const first = wire.frame("thread.effort.set", setParams);
  const applying = wire.exchange(first);
  wire.inject(first);
  const applied = await applying;
  assert.ok(applied.result && typeof applied.result === "object" && "revision" in applied.result);
  assert.equal(applied.result.revision, updatedRevision);
  assert.deepEqual(setCalls, [setParams]);

  const retry = await wire.exchange(wire.frame("thread.effort.set", setParams));
  assert.deepEqual(retry.result, applied.result);
  assert.deepEqual(setCalls, [setParams, setParams]);
});

test("Wire 1.4 maps Runtime effort errors and redacts private messages", async (t) => {
  let reason: string | undefined;
  const wire = await connectBridge(t, "1.4", {
    ...unusedClientMethods,
    getInitializationResult: () => ({ protocolVersion: "1.7" }),
    setThreadModel: async () => {
      throw new RollRpcError({
        code: -32602,
        message: "会话已关闭 /private/path",
        data: {
          rollCode: "INVALID_PARAMS",
          retryable: false,
          ...(reason ? { details: { modelSelection: reason } } : {}),
        },
      });
    },
  });
  for (const [runtimeReason, code, message, retryable] of [
    [
      "effort-unsupported",
      RELAY_ERROR_CODES_V14.threadEffortUnsupported,
      "Requested thread effort is unsupported for the current model",
      false,
    ],
    [
      "revision-conflict",
      RELAY_ERROR_CODES_V14.threadEffortStateStale,
      "Thread effort state is stale; refresh and retry",
      true,
    ],
    [
      "config-changed",
      RELAY_ERROR_CODES_V14.threadEffortStateStale,
      "Thread effort state is stale; refresh and retry",
      true,
    ],
  ] as const) {
    reason = runtimeReason;
    const response = await wire.exchange(
      wire.frame("thread.effort.set", { ...setParams, requestId: randomUUID() }),
    );
    assert.deepEqual(response.error, { code, message, retryable });
  }
  reason = undefined;
  const detached = await wire.exchange(
    wire.frame("thread.effort.set", { ...setParams, requestId: randomUUID() }),
  );
  assert.equal(detached.error?.code, RELAY_ERROR_CODES.invalidParams);
  assert.doesNotMatch(detached.error.message, /private|已关闭/u);
});

test("legacy Relay ignores effort frames and Wire 1.4 refuses a 1.6 Runtime before dispatch", async (t) => {
  let reads = 0;
  const client: CompanionRuntimeClient = {
    ...unusedClientMethods,
    getInitializationResult: () => ({ protocolVersion: "1.6" }),
    getThreadModel: async () => {
      reads++;
      throw new Error("unexpected dispatch");
    },
  };
  for (const version of ["1.2", "1.3"] as const) {
    const wire = await connectBridge(t, version, client);
    wire.inject(wire.frame("thread.effort.get", { threadId }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(!wire.outbound.some((frame) => frame.type === "runtime.response"));
  }
  const wire = await connectBridge(t, "1.4", client);
  const result = await wire.exchange(wire.frame("thread.effort.get", { threadId }));
  assert.deepEqual(result.error, {
    code: RELAY_ERROR_CODES_V14.threadEffortUnsupported,
    message: "Runtime does not support per-thread effort",
    retryable: false,
  });
  assert.equal(reads, 0);
});
