import assert from "node:assert/strict";
import { ScheduleStore } from "@roll-agent/runtime";
import { takeScheduleExecEnv } from "./exec-env.ts";
import { executeInvocation } from "./execute-invocation.ts";
import { readExecutorIdentityWithRetry } from "./executor-liveness.ts";
import { INVOCATION_TREE_TEARDOWN_OUTCOMES } from "./invocation-tree.ts";

// An isolated executor: real ledger/ownership/settlement, deterministic turn, no external tools.
const env = takeScheduleExecEnv(process.env);
assert.deepEqual(process.argv.slice(2, 5), ["schedule", "exec", "--invocation"]);
const invocationId = process.argv[5];
assert.ok(invocationId);
const nowMs = Number(process.env.ROLL_FINITE_TEST_NOW);
assert.ok(Number.isSafeInteger(nowMs));
const executor = readExecutorIdentityWithRetry();
assert.ok(executor, "the real subprocess must have a verified OS start identity");
const store = new ScheduleStore(env.dataDir);
try {
  const result = await executeInvocation({
    store,
    invocationId,
    ownershipToken: env.ownershipToken,
    executor,
    now: () => nowMs + 1,
    // This fixture starts no tools or children, so both teardown phases have an empty tree.
    teardownTree: async () => ({
      outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.clean,
      terminatedPids: [],
      survivorPids: [],
      skippedReusedGroups: [],
    }),
    runTurn: async (schedule, invocation) => {
      const expectedRounds = Number(process.env.ROLL_FINITE_TEST_ROUNDS ?? "1");
      assert.equal(schedule.maxRounds, expectedRounds);
      assert.equal(schedule.roundsStarted, expectedRounds);
      assert.equal(invocation.id, invocationId);
      return invocation.attempt === 1
        ? { status: "failed", error: "isolated first-attempt failure" }
        : { status: "completed", threadId: "isolated-final-thread", output: "no unread messages" };
    },
  });
  assert.ok(result.kind === "failed" || result.kind === "completed");
  process.exitCode = result.kind === "failed" ? 1 : 0;
} finally {
  store.close();
}
