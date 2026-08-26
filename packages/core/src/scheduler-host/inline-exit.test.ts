import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INVOCATION_STATUSES, ScheduleStore, createIntervalTrigger } from "@roll-agent/runtime";
import {
  INLINE_EXIT_DECISIONS,
  createInlineStopForwarder,
  decideInlineExit,
  settleInlineInvocation,
} from "./inline-exit.ts";

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

test("inline 信号转发：首个信号按平台转发，重复信号升级为 SIGKILL，killOutcome 记录最近一次结果", () => {
  const signals: string[] = [];
  const outcomes: Array<"failed" | "tree-terminated"> = ["failed", "tree-terminated"];
  const handle = {
    kill: (signal: "SIGTERM" | "SIGKILL") => {
      signals.push(signal);
      return outcomes.shift() ?? "tree-terminated";
    },
  };
  const posix = createInlineStopForwarder(handle, "darwin");
  assert.equal(posix.killOutcome(), undefined);
  posix.forward();
  assert.equal(posix.killOutcome(), "failed");
  posix.escalate();
  assert.equal(posix.killOutcome(), "tree-terminated");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  const windows = createInlineStopForwarder(handle, "win32");
  windows.forward();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGKILL"]);
});

function seedRunningInvocation(store: ScheduleStore): {
  readonly id: string;
  readonly ownershipToken: string;
} {
  const schedule = store.createSchedule({
    name: "inline",
    prompt: "p",
    cwd: "/workspace",
    trigger: createIntervalTrigger("30m"),
    fireImmediately: false,
  });
  const queued = store.enqueueManualInvocation(schedule.id);
  const claim = store.claimPendingInvocation(queued.id, "inline-test");
  assert.ok(claim);
  store.beginInvocation(queued.id, claim.ownershipToken, Date.now(), {
    pid: 4242,
    startToken: "pst-v2:root",
  });
  return { id: queued.id, ownershipToken: claim.ownershipToken };
}

test("inline 结算：后代存活或探活 unknown 时保留 running；树终止未确认时即使探活 dead 也保留；只有 dead 且树已确认才记失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    let liveness: "descendants-alive" | "unknown" | "dead" = "descendants-alive";
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    const running = seedRunningInvocation(store);
    const settle = (killOutcome: "failed" | "tree-terminated" | undefined) =>
      settleInlineInvocation({
        store,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        killOutcome,
        exitCode: null,
      });
    assert.equal(settle(undefined), INLINE_EXIT_DECISIONS.holdDescendants);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    liveness = "unknown";
    assert.equal(settle("tree-terminated"), INLINE_EXIT_DECISIONS.holdDescendants);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    liveness = "dead";
    assert.equal(settle("failed"), INLINE_EXIT_DECISIONS.holdUnconfirmedKill);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    assert.equal(settle("tree-terminated"), INLINE_EXIT_DECISIONS.fail);
    assert.notEqual(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    assert.match(store.getInvocation(running.id)?.error ?? "", /exec 进程退出 code=null/u);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline 结算：exec 自己已写入终态时不探活、不改写结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    let probes = 0;
    const store = new ScheduleStore(dir, {
      executorLiveness: () => {
        probes += 1;
        return "alive";
      },
    });
    const running = seedRunningInvocation(store);
    store.failInvocation(running.id, running.ownershipToken, "exec 自己写的结果", Date.now(), {
      terminal: true,
    });
    assert.equal(
      settleInlineInvocation({
        store,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        killOutcome: undefined,
        exitCode: 1,
      }),
      INLINE_EXIT_DECISIONS.fail,
    );
    assert.equal(probes, 0);
    assert.equal(store.getInvocation(running.id)?.error, "exec 自己写的结果");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
