import assert from "node:assert/strict";
import { test } from "node:test";
import {
  operationResultGetParamsSchema,
  operationResultGetResultSchema,
} from "@roll-agent/protocol";
import { relayRuntimeRequestSchemaV12, workspaceIdSchema } from "@roll-agent/relay-protocol";
import { CompanionWorkspace, type CompanionRuntimeClient } from "./companion-workspace.ts";
import { CompanionInteractionBroker } from "./interaction-broker.ts";

const workspaceId = workspaceIdSchema.parse("00000000-0000-4000-8000-000000000001");
const params = operationResultGetParamsSchema.parse({
  threadId: "00000000-0000-4000-8000-000000000002",
  operationId: "00000000-0000-4000-8000-000000000003",
});
const request = relayRuntimeRequestSchemaV12.parse({
  type: "runtime.request",
  requestId: "00000000-0000-4000-8000-000000000004",
  workspaceId,
  method: "operation.result.get",
  params,
});
const context = {
  workspaceId,
  requestId: request.requestId,
  signal: new AbortController().signal,
  responderPolicy: () => true,
  responderContext: {},
};

test("App result reads require producer and live host grants and never cache an earlier grant", async () => {
  let granted = false;
  let producerAllows = true;
  let reads = 0;
  const client: CompanionRuntimeClient = {
    request: () => Promise.reject(new Error("unexpected legacy method")),
    onEvent: () => () => undefined,
    getInitializationResult: () => ({ protocolVersion: "1.5" }),
    getOperationResult: async () => {
      reads++;
      return operationResultGetResultSchema.parse({
        result: {
          ...params,
          agentName: "synthetic-candidates",
          toolName: "search",
          createdAt: new Date(0).toISOString(),
          output: {
            status: "available",
            schemaId: "example.candidates",
            schemaVersion: 1,
            remoteReadable: producerAllows,
            data: { candidates: [{ name: "张三" }] },
            fallbackText: "1 candidate",
          },
        },
      });
    },
    close: () => undefined,
  };
  const workspace = new CompanionWorkspace({
    client,
    workspaceId,
    localApprovalPolicy: () => "allow",
    interactionBroker: new CompanionInteractionBroker(),
    remoteAppOutputPolicy: (agent, tool) =>
      granted && agent === "synthetic-candidates" && tool === "search",
  });
  const read = async () =>
    operationResultGetResultSchema.parse(await workspace.handleRemoteRequestV11(request, context))
      .result?.output;
  assert.deepEqual(await read(), { status: "denied" });
  granted = true;
  assert.equal((await read())?.status, "available");
  granted = false;
  assert.deepEqual(await read(), { status: "denied" });
  granted = true;
  producerAllows = false;
  assert.deepEqual(await read(), { status: "denied" });
  assert.equal(reads, 4);
  await assert.rejects(
    workspace.handleRemoteRequestV11(request, {
      ...context,
      workspaceId: workspaceIdSchema.parse("00000000-0000-4000-8000-000000000005"),
    }),
    /Workspace access denied/,
  );
  assert.equal(reads, 4);
  await workspace.closeIfIdle();
});

test("capabilities advertise only currently effective remote output access", async () => {
  const { projectRemoteAppOutputCapabilities } = await import("./remote-app-output.ts");
  const manifest = {
    tools: [
      {
        agentName: "example",
        toolName: "search",
        appOutput: { schemaId: "example", schemaVersion: 1, remoteReadable: true },
      },
    ],
  };
  assert.deepEqual(await projectRemoteAppOutputCapabilities({ manifest }, true, () => false), {
    manifest: {
      ...manifest,
      tools: [
        {
          ...manifest.tools[0],
          appOutput: { ...manifest.tools[0]?.appOutput, remoteReadable: false },
        },
      ],
      appOutput: { supported: true },
    },
  });
  const enabled = await projectRemoteAppOutputCapabilities({ manifest }, true, () => true);
  assert.deepEqual(enabled, { manifest: { ...manifest, appOutput: { supported: true } } });
  const unsupported = await projectRemoteAppOutputCapabilities({ manifest }, false, () => true);
  assert.equal(JSON.stringify(unsupported).includes('"remoteReadable":false'), true);
});

test("legacy frame materialization strips App metadata while Wire 1.2 retains it", async () => {
  const { materializeRelayFrameV11, materializeRelayFrameV12 } =
    await import("./relay-frame-buffer.ts");
  const { relayRuntimeEventEnvelopeSchemaV12 } = await import("@roll-agent/relay-protocol");
  const entry = {
    type: "runtime.event" as const,
    relaySequence: 0,
    event: relayRuntimeEventEnvelopeSchemaV12.parse({
      protocolVersion: "1.1",
      runtimeInstanceId: "00000000-0000-4000-8000-000000000010",
      sequence: 0,
      timestamp: new Date(0).toISOString(),
      threadId: params.threadId,
      event: {
        type: "tool.completed",
        toolCallId: "call",
        agentName: "example",
        toolName: "search",
        operationId: params.operationId,
        appOutput: { status: "available", schemaId: "example.candidates", schemaVersion: 1 },
      },
    }),
  };
  assert.equal(
    JSON.stringify(materializeRelayFrameV11(workspaceId, entry)).includes("appOutput"),
    false,
  );
  assert.equal(
    JSON.stringify(materializeRelayFrameV12(workspaceId, entry)).includes("appOutput"),
    true,
  );
});
