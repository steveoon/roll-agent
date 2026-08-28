import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPANION_RUNTIME_PROTOCOL_VERSIONS,
  isBridgeableRuntimeProtocolVersion,
} from "./host-session.ts";

test("the Companion bridges only reviewed Runtime Protocol versions", () => {
  for (const version of COMPANION_RUNTIME_PROTOCOL_VERSIONS) {
    assert.equal(isBridgeableRuntimeProtocolVersion(version), true);
  }

  // Older Runtimes route Interactions outside the server-request channel, and an unreleased version
  // has not been reviewed against this Host.
  for (const version of ["1.0", "1.1", "1.2", "1.5", "", "1.30"]) {
    assert.equal(isBridgeableRuntimeProtocolVersion(version), false, `expected ${version} refused`);
  }
});
