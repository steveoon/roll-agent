import { test } from "node:test";
import assert from "node:assert/strict";
import { INLINE_EXIT_DECISIONS, decideInlineExit } from "./inline-exit.ts";

test("inline 退出判定：只有树终止已确认且执行者证实已死才记失败，其余一律保留 running", () => {
  assert.equal(
    decideInlineExit({ killOutcome: undefined, liveness: undefined }),
    INLINE_EXIT_DECISIONS.fail,
  );
  assert.equal(
    decideInlineExit({ killOutcome: "tree-terminated", liveness: "dead" }),
    INLINE_EXIT_DECISIONS.fail,
  );
  assert.equal(
    decideInlineExit({ killOutcome: "failed", liveness: "dead" }),
    INLINE_EXIT_DECISIONS.holdUnconfirmedKill,
  );
  assert.equal(
    decideInlineExit({ killOutcome: "root-only", liveness: undefined }),
    INLINE_EXIT_DECISIONS.holdUnconfirmedKill,
  );
  assert.equal(
    decideInlineExit({ killOutcome: undefined, liveness: "descendants-alive" }),
    INLINE_EXIT_DECISIONS.holdDescendants,
  );
  assert.equal(
    decideInlineExit({ killOutcome: undefined, liveness: "unknown" }),
    INLINE_EXIT_DECISIONS.holdDescendants,
  );
  assert.equal(
    decideInlineExit({ killOutcome: "tree-terminated", liveness: "alive" }),
    INLINE_EXIT_DECISIONS.holdDescendants,
  );
});
