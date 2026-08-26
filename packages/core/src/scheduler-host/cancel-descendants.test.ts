import { test } from "node:test";
import assert from "node:assert/strict";
import { KILL_RESULTS, descendantsUnverified } from "./cancel-descendants.ts";

test("cancel --kill 的后代不可验证告警：Windows 上只要杀过就提示，POSIX 只在探活 unverifiable 时提示", () => {
  assert.equal(
    descendantsUnverified({ killResult: KILL_RESULTS.confirmed, killed: true, platform: "win32" }),
    true,
  );
  assert.equal(
    descendantsUnverified({
      killResult: KILL_RESULTS.unverifiable,
      killed: false,
      platform: "win32",
    }),
    true,
  );
  assert.equal(
    descendantsUnverified({ killResult: KILL_RESULTS.confirmed, killed: true, platform: "darwin" }),
    false,
  );
  assert.equal(
    descendantsUnverified({
      killResult: KILL_RESULTS.unverifiable,
      killed: false,
      platform: "linux",
    }),
    true,
  );
  assert.equal(
    descendantsUnverified({ killResult: undefined, killed: false, platform: "win32" }),
    false,
  );
});
