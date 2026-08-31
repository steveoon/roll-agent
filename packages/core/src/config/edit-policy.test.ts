import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRollConfigReadOnlyPath } from "./edit-policy.ts";

describe("isRollConfigReadOnlyPath", () => {
  it("marks scheduler.dataDir as read-only for the web form", () => {
    assert.equal(isRollConfigReadOnlyPath(["scheduler", "dataDir"]), true);
  });

  it("keeps every other path editable", () => {
    assert.equal(isRollConfigReadOnlyPath(["scheduler", "maxConcurrentRuns"]), false);
    assert.equal(isRollConfigReadOnlyPath(["scheduler", "maxSchedules"]), false);
    assert.equal(isRollConfigReadOnlyPath(["scheduler"]), false);
    assert.equal(isRollConfigReadOnlyPath(["agents", "dataDir"]), false);
    assert.equal(isRollConfigReadOnlyPath(["runtime", "threadsDir"]), false);
  });
});
