import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_STATUSES,
  ScheduleStore,
  createIntervalTrigger,
} from "@roll-agent/runtime";
import { executeInvocation, type ScheduledTurnRunner } from "./execute-invocation.ts";

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-exec-"));
}

function claimOne(store: ScheduleStore) {
  store.createSchedule(
    {
      name: "巡检",
      prompt: "检查未读",
      cwd: "/workspace",
      trigger: createIntervalTrigger("30m"),
      fireImmediately: true,
    },
    NOW,
  );
  const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
  assert.ok(claim);
  return claim;
}

test("executeInvocation 完成后写入 thread id 与输出摘录", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const runTurn: ScheduledTurnRunner = (schedule, invocation) => {
      assert.equal(invocation.status, INVOCATION_STATUSES.running);
      assert.equal(schedule.prompt, "检查未读");
      return Promise.resolve({
        status: "completed",
        threadId: "thread-1",
        output: "ok".repeat(5_000),
      });
    };
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn,
      now: () => NOW + 10,
    });
    assert.deepEqual(result, {
      kind: "completed",
      invocationId: claim.invocation.id,
      threadId: "thread-1",
    });
    const stored = store.getInvocation(claim.invocation.id);
    assert.equal(stored?.status, INVOCATION_STATUSES.completed);
    assert.equal(stored?.threadId, "thread-1");
    assert.equal(stored?.outputExcerpt?.length, 4_000);
    assert.equal(stored?.finishedAtMs, NOW + 10);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeInvocation 记录 needs_confirmation 与 pendingActions", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () =>
        Promise.resolve({
          status: "needs_confirmation",
          threadId: "thread-2",
          output: "partial",
          pendingActions: ["browser.click"],
        }),
    });
    assert.equal(result.kind, "needs_confirmation");
    assert.deepEqual(store.getInvocation(claim.invocation.id)?.pendingActions, ["browser.click"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner 抛错或返回 failed 走 failInvocation", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const claim = claimOne(store);
    const thrown = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () => Promise.reject(new Error("model exploded")),
    });
    assert.deepEqual(thrown, {
      kind: "failed",
      invocationId: claim.invocation.id,
      error: "model exploded",
      outcome: INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    });
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.retry);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token 不匹配返回 lost-claim 且不调用 runner", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    let called = false;
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: "stale",
      runTurn: () => {
        called = true;
        return Promise.resolve({ status: "completed", threadId: "t", output: "" });
      },
    });
    assert.deepEqual(result, { kind: "lost-claim", invocationId: claim.invocation.id });
    assert.equal(called, false);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.claimed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeInvocation 把 executor 身份写进 invocation，终态失败直接 failed 并 pause", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const claim = claimOne(store);
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      executor: { pid: 4321, startToken: "pst-v2:test" },
      runTurn: (_schedule, invocation) => {
        assert.deepEqual(invocation.executor, { pid: 4321, startToken: "pst-v2:test" });
        return Promise.resolve({ status: "failed", error: "权限边界已变化", terminal: true });
      },
    });
    assert.deepEqual(result, {
      kind: "failed",
      invocationId: claim.invocation.id,
      error: "权限边界已变化",
      outcome: INVOCATION_FAILURE_OUTCOMES.terminalPaused,
    });
    const stored = store.getInvocation(claim.invocation.id);
    assert.equal(stored?.status, INVOCATION_STATUSES.failed);
    assert.equal(stored?.attempt, 1);
    assert.equal(store.getSchedule(claim.schedule.id)?.status, "paused");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeInvocation 收到停止信号后不写账本，行保持 running 交由发起方收尾", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const controller = new AbortController();
    const runTurn: ScheduledTurnRunner = () => {
      controller.abort(new Error("scheduled exec stopping"));
      return Promise.resolve({ status: "failed", error: "本轮执行已收到停止请求" });
    };
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn,
      stopSignal: controller.signal,
      now: () => NOW + 10,
    });
    assert.deepEqual(result, {
      kind: "interrupted",
      invocationId: claim.invocation.id,
      error: "本轮执行已收到停止请求",
    });
    const record = store.getInvocation(claim.invocation.id);
    assert.equal(record?.status, INVOCATION_STATUSES.running);
    assert.equal(record?.claimedBy, "w1");
    assert.equal(record?.attempt, claim.invocation.attempt);
    assert.equal(store.getSchedule(claim.schedule.id)?.status, "active");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeInvocation 的 turn 在停止信号后抛错时同样不消耗 attempt", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const controller = new AbortController();
    const runTurn: ScheduledTurnRunner = () => {
      controller.abort(new Error("scheduled exec stopping"));
      return Promise.reject(new Error("session torn down"));
    };
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn,
      stopSignal: controller.signal,
      now: () => NOW + 10,
    });
    assert.equal(result.kind, "interrupted");
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    assert.equal(
      store.failInvocation(claim.invocation.id, claim.ownershipToken, "daemon 收尾", NOW + 11),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
