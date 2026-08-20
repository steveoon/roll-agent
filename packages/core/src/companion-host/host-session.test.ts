import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_PROTOCOL_VERSION } from "@roll-agent/protocol";
import { assertBundledRuntimeProtocolVersion } from "./host-session.ts";

test("bundled runtime must negotiate the current runtime protocol version", () => {
  assertBundledRuntimeProtocolVersion(RUNTIME_PROTOCOL_VERSION);
  assert.throws(
    () => assertBundledRuntimeProtocolVersion("0.9"),
    /must negotiate Runtime Protocol/u,
  );
  assert.throws(
    () => assertBundledRuntimeProtocolVersion("1.3"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(RUNTIME_PROTOCOL_VERSION));
      assert.ok(error.message.includes("1.3"));
      return true;
    },
  );
});
