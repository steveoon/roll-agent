import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDebugEvent } from "./debug-format.ts";

test("formatDebugEvent preserves compaction elapsed time and phase timings", () => {
  assert.equal(
    formatDebugEvent({
      type: "debug",
      stage: "compaction",
      message: "finish",
      elapsedMs: 41_205,
      data: {
        evidenceBuildMs: 7,
        draftGenerationMs: 41_180,
        validationMs: 12,
        checkpointCommitMs: 6,
      },
    }),
    'chat.compaction · finish · 41205ms · {"evidenceBuildMs":7,"draftGenerationMs":41180,"validationMs":12,"checkpointCommitMs":6}',
  );
});

test("formatDebugEvent omits absent optional diagnostics", () => {
  assert.equal(
    formatDebugEvent({ type: "debug", stage: "turn", message: "start" }),
    "chat.turn · start",
  );
});
