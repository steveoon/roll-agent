import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createStdioConnection } from "./stdio.ts";
import type { JsonRpcMessage } from "../protocol.ts";

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("stdio adapter reports parse errors, invalid requests and oversized frames", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    frames.push(...chunk.trim().split("\n"));
  });
  const connection = createStdioConnection(input, output, { maxFrameBytes: 32 });

  input.write("{\n");
  input.write('{"jsonrpc":"2.0","id":7}\n');
  input.write(`${"x".repeat(33)}\n`);
  await nextTick();
  await nextTick();

  const messages = frames.map((frame) => JSON.parse(frame) as JsonRpcMessage);
  assert.deepEqual(
    messages.map((message) => ("error" in message ? message.error.code : undefined)),
    [-32_700, -32_600, -32_600],
  );
  assert.equal("id" in messages[0]! ? messages[0].id : undefined, null);
  const invalidRequest = messages[1];
  assert.ok(invalidRequest !== undefined && "id" in invalidRequest);
  assert.equal(invalidRequest.id, 7);
  assert.equal("id" in messages[2]! ? messages[2].id : undefined, null);
  connection.close();
});

test("stdio adapter forwards valid frames and preserves output order under backpressure", async () => {
  const input = new PassThrough();
  const received: JsonRpcMessage[] = [];
  const written: string[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString("utf8"));
      setImmediate(callback);
    },
  });
  const connection = createStdioConnection(input, output);
  connection.onMessage((message) => received.push(message));

  input.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n');
  connection.send({ jsonrpc: "2.0", id: 1, result: "first" });
  connection.send({ jsonrpc: "2.0", id: 2, result: "second" });
  connection.send({ jsonrpc: "2.0", id: 3, result: "third" });
  for (let index = 0; index < 10 && written.length < 3; index += 1) {
    await nextTick();
  }

  assert.equal(received.length, 1);
  assert.deepEqual(
    written.map((frame) => (JSON.parse(frame) as { readonly id: number }).id),
    [1, 2, 3],
  );
  connection.close();
});
