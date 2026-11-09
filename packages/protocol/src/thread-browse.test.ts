import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_METHODS,
  isRuntimeMethodAvailable,
  parseLatestRuntimeMethodParams,
  parseLatestRuntimeMethodResult,
  sessionOccupancySchema,
  threadListResultSchema,
} from "./index.ts";

test("thread.browse is an optional 1.6 method with bounded workspace and occupancy metadata", () => {
  assert.equal(isRuntimeMethodAvailable("1.6", RUNTIME_METHODS.threadBrowse), true);
  for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"] as const) {
    assert.equal(isRuntimeMethodAvailable(version, RUNTIME_METHODS.threadBrowse), false);
  }
  assert.deepEqual(parseLatestRuntimeMethodParams("thread.browse", { workspace: null }), {
    workspace: null,
    limit: 100,
  });
  for (const params of [
    { workspace: "" },
    { workspace: "x".repeat(4097) },
    { limit: 501 },
    { cursor: "-1" },
    { project: "unregistered" },
  ]) {
    assert.throws(() => parseLatestRuntimeMethodParams("thread.browse", params));
  }
  assert.equal(sessionOccupancySchema.safeParse({ status: "unknown" }).success, true);
  assert.equal(
    sessionOccupancySchema.safeParse({
      status: "occupied",
      owner: { kind: "runtime", label: "desktop", identity: "private" },
    }).success,
    false,
  );
  assert.equal(
    sessionOccupancySchema.safeParse({
      status: "occupied",
      owner: { kind: "runtime", label: "x".repeat(201) },
    }).success,
    false,
  );
});

test("browse metadata does not change frozen list summaries", () => {
  const thread = {
    id: "e9754759-ff40-471b-9b73-cad9bf6aaa65",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messageCount: 0,
  };
  const result = {
    items: [{ thread, workspace: "/workspace/a", occupancy: { status: "available" } }],
    nextCursor: null,
  };
  assert.deepEqual(parseLatestRuntimeMethodResult("thread.browse", result), result);
  assert.deepEqual(threadListResultSchema.parse({ items: [thread], nextCursor: null }), {
    items: [thread],
    nextCursor: null,
  });
  assert.throws(() =>
    threadListResultSchema.parse({
      items: [{ ...thread, workspace: "/workspace/a" }],
      nextCursor: null,
    }),
  );
});
