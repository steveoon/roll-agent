import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  isRuntimeMethodAvailable,
  runtimeMethodSchemas,
  threadModelSelectionSchema,
  threadModelStatusSchema,
} from "./index.ts";

test("thread model methods are optional 1.6 extensions", () => {
  for (const method of ["runtime.models.list", "thread.model.get", "thread.model.set"] as const) {
    assert.equal(isRuntimeMethodAvailable("1.6", method), true);
    for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"] as const) {
      assert.equal(isRuntimeMethodAvailable(version, method), false);
    }
  }
});

test("model selection rejects incomplete, unbounded and credential-bearing values", () => {
  assert.deepEqual(threadModelSelectionSchema.parse({ mode: "default" }), { mode: "default" });
  assert.deepEqual(
    threadModelSelectionSchema.parse({ mode: "explicit", provider: "p", model: "m" }),
    { mode: "explicit", provider: "p", model: "m" },
  );
  for (const value of [
    { mode: "explicit", provider: "p" },
    { mode: "default", model: "m" },
    { mode: "explicit", provider: "p", model: "x".repeat(513) },
    { mode: "explicit", provider: "p", model: "m", apiKey: "secret" },
  ]) {
    assert.equal(threadModelSelectionSchema.safeParse(value).success, false);
  }
  assert.equal(runtimeMethodSchemas["runtime.models.list"].params.safeParse({}).success, true);
  assert.equal(
    threadModelStatusSchema.safeParse({ status: "failed", reason: "private error" }).success,
    false,
  );
  assert.equal(
    threadModelStatusSchema.safeParse({
      threadId: randomUUID(),
      revision: randomUUID(),
      configRevision: "config",
      selection: { mode: "default" },
      status: "applied",
      active: null,
    }).success,
    false,
  );
});
