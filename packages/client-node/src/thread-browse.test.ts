import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { projectClientCapabilitiesSetResult } from "@roll-agent/protocol";
import { RollNodeClient } from "./index.ts";

test("browseThreads uses the typed optional 1.6 method and preserves unclassified and occupied metadata", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reader = createInterface({ input: stdin });
  const requests: unknown[] = [];
  const response = {
    items: [
      {
        thread: {
          id: randomUUID(),
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          messageCount: 2,
        },
        workspace: null,
        occupancy: { status: "occupied", owner: { kind: "runtime", label: "Desktop" } },
      },
    ],
    nextCursor: null,
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
    requests.push(request);
    const params = "params" in request ? request.params : undefined;
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "1.6",
            runtimeInstanceId: randomUUID(),
            server: { name: "fixture", version: "1", runtimeVersion: "1" },
            features: ["thread-management"],
            limits: {
              maxFrameBytes: 4194304,
              maxPageSize: 500,
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
          : response;
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
  let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const client = await RollNodeClient.connect({
    transport: {
      stdin,
      stdout,
      onExit(listener) {
        exit = listener;
      },
      close() {
        exit?.(0, null);
      },
    },
  });
  try {
    assert.deepEqual(await client.browseThreads({ workspace: null, limit: 1 }), response);
    assert.ok(
      requests.some(
        (request) =>
          typeof request === "object" &&
          request !== null &&
          "method" in request &&
          request.method === "thread.browse" &&
          "params" in request &&
          JSON.stringify(request.params) === JSON.stringify({ workspace: null, limit: 1 }),
      ),
    );
    assert.equal(client.getInitializationResult().features.includes("thread-management"), true);
  } finally {
    await client.shutdown();
    reader.close();
  }
});
