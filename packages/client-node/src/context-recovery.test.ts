import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  projectClientCapabilitiesSetResult,
  runtimeEventEnvelopeV16Schema,
} from "@roll-agent/protocol";
import { RollNodeClient } from "./index.ts";

test("Node Client negotiates 1.6 and accepts durable recovery events and recovery snapshots", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reader = createInterface({ input: stdin });
  const runtimeInstanceId = randomUUID();
  const threadId = randomUUID();
  const eventId = randomUUID();
  const state = {
    checkpointId: randomUUID(),
    required: true,
    unextracted: false,
    requiredItemCount: 24,
  };
  const snapshot = {
    thread: {
      id: threadId,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
    eventCursor: null,
    recoveryProjection: true,
    contextRecovery: state,
  };
  reader.on("line", (line: string) => {
    const request: unknown = JSON.parse(line);
    if (
      typeof request !== "object" ||
      request === null ||
      !("id" in request) ||
      !("method" in request)
    ) {
      return;
    }
    const params = "params" in request ? request.params : undefined;
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "1.6",
            runtimeInstanceId,
            server: { name: "fixture", version: "1", runtimeVersion: "1" },
            features: ["context-recovery"],
            limits: {
              maxFrameBytes: 4194304,
              maxPageSize: 100,
              eventReplay: true,
              idempotencyCacheEntries: 100,
              maxAttachmentBytes: 16777216,
              maxAttachmentChunkBytes: 2097152,
              maxTurnAttachments: 8,
              maxStagedAttachments: 16,
            },
          }
        : request.method === "client.capabilities.set"
          ? projectClientCapabilitiesSetResult(params)
          : snapshot;
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
  let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const client = await RollNodeClient.connect({
    transport: {
      stdin,
      stdout,
      onExit: (listener) => {
        exit = listener;
      },
      close: () => {
        exit?.(0, null);
      },
    },
  });
  try {
    const result = await client.request("thread.snapshot", { threadId, recovery: true, limit: 1 });
    assert.ok("contextRecovery" in result);
    assert.deepEqual(result.contextRecovery, state);
    const observed = new Promise<unknown>((resolve) => client.onEvent(resolve));
    const event = runtimeEventEnvelopeV16Schema.parse({
      protocolVersion: "1.6",
      runtimeInstanceId,
      threadId,
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      durability: "durable",
      eventId,
      cursor: `rte1:${randomUUID()}:0:${eventId}`,
      event: { type: "context.recovery.changed", contextRecovery: { ...state, required: false } },
    });
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "runtime.event", params: event })}\n`);
    assert.deepEqual(await observed, event);
  } finally {
    client.close();
    reader.close();
    stdin.destroy();
    stdout.destroy();
  }
});
