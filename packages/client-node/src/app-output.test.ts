import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { projectClientCapabilitiesSetResult } from "@roll-agent/protocol";
import { RollNodeClient } from "./index.ts";

for (const version of ["1.5", "1.4"] as const) {
  test(`app result query is gated by negotiated ${version}`, async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const reader = createInterface({ input: stdin });
    let calls = 0;
    let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
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
              protocolVersion: version,
              runtimeInstanceId: "00000000-0000-4000-8000-000000000001",
              server: { name: "fixture", version: "1", runtimeVersion: "1" },
              features: version === "1.5" ? ["app-output"] : [],
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
            : { result: null };
      if (request.method === "operation.result.get") calls++;
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const client = await RollNodeClient.connect({
      transport: {
        stdin,
        stdout,
        onExit: (listener) => {
          exitListener = listener;
        },
        close: () => {
          reader.close();
          exitListener?.(0, null);
        },
      },
    });
    try {
      const request = client.getOperationResult({
        threadId: "00000000-0000-4000-8000-000000000002",
        operationId: "00000000-0000-4000-8000-000000000003",
      });
      if (version === "1.5") {
        assert.deepEqual(await request, { result: null });
        assert.equal(calls, 1);
      } else {
        await assert.rejects(request);
        assert.equal(calls, 0);
      }
    } finally {
      client.close();
      reader.close();
      stdin.destroy();
      stdout.destroy();
    }
  });
}
