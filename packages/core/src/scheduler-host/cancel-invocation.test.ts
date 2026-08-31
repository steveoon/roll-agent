import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXECUTOR_LIVENESS,
  INVOCATION_STATUSES,
  ScheduleStore,
  createIntervalTrigger,
  type ExecutorLiveness,
  type InvocationRecord,
} from "@roll-agent/runtime";
import { cancelScheduledInvocation } from "./cancel-invocation.ts";
import { KILL_PROCESS_TREE_OUTCOMES } from "./executor-liveness.ts";
import {
  INVOCATION_TREE_TEARDOWN_OUTCOMES,
  type InvocationTreeTeardown,
} from "./invocation-tree.ts";

const NOW = Date.parse("2026-08-31T09:00:00.000Z");
const DUE = NOW + 1_800_000;

function tempDir(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "roll-cancel-invocation-"));
}

function settledTeardown(): InvocationTreeTeardown {
  return {
    outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.clean,
    terminatedPids: [],
    survivorPids: [],
    skippedReusedGroups: [],
  };
}

interface Harness {
  readonly store: ScheduleStore;
  readonly invocation: InvocationRecord;
  readonly ownershipToken: string;
  setLiveness(next: ExecutorLiveness): void;
  close(): void;
}

function createClaimedInvocation(dir: string): Harness {
  let liveness: ExecutorLiveness = EXECUTOR_LIVENESS.dead;
  const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
  store.createSchedule(
    {
      name: "巡检",
      prompt: "检查未读消息",
      cwd: "/workspace/demo",
      trigger: createIntervalTrigger("30m"),
    },
    NOW,
  );
  const claims = store.claimDue({ workerId: "w1", nowMs: DUE, limit: 1 });
  const claim = claims[0];
  assert.ok(claim);
  return {
    store,
    invocation: claim.invocation,
    ownershipToken: claim.ownershipToken,
    setLiveness: (next) => {
      liveness = next;
    },
    close: () => store.close(),
  };
}

test("cancelScheduledInvocation 取消排队中的 invocation（纯账本档）", async () => {
  const dir = tempDir();
  const harness = createClaimedInvocation(dir);
  try {
    const result = await cancelScheduledInvocation({
      store: harness.store,
      invocationId: harness.invocation.id,
      kill: false,
    });
    assert.equal(result.killed, false);
    assert.equal(result.unverifiedDescendants, false);
    assert.equal(result.previousStatus, INVOCATION_STATUSES.claimed);
    assert.equal(result.invocation.status, INVOCATION_STATUSES.failed);
    assert.equal(result.invocation.error, "已由用户取消");
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelScheduledInvocation 拒绝取消仍存活的运行（提示加 --kill）", async () => {
  const dir = tempDir();
  const harness = createClaimedInvocation(dir);
  try {
    harness.setLiveness(EXECUTOR_LIVENESS.alive);
    harness.store.beginInvocation(harness.invocation.id, harness.ownershipToken, DUE, {
      pid: 4242,
      startToken: "boot-token",
    });
    await assert.rejects(
      cancelScheduledInvocation({
        store: harness.store,
        invocationId: harness.invocation.id,
        kill: false,
      }),
      /取消需要加 --kill/u,
    );
    assert.equal(
      harness.store.getInvocation(harness.invocation.id)?.status,
      INVOCATION_STATUSES.running,
    );
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelScheduledInvocation --kill 档：杀树、确认退出后取消", async () => {
  const dir = tempDir();
  const harness = createClaimedInvocation(dir);
  try {
    harness.setLiveness(EXECUTOR_LIVENESS.alive);
    harness.store.beginInvocation(harness.invocation.id, harness.ownershipToken, DUE, {
      pid: 4242,
      startToken: "boot-token",
    });
    const killedPids: number[] = [];
    const result = await cancelScheduledInvocation(
      { store: harness.store, invocationId: harness.invocation.id, kill: true },
      {
        terminateExecutor: async (executor) => {
          killedPids.push(executor.pid);
          harness.setLiveness(EXECUTOR_LIVENESS.dead);
          return KILL_PROCESS_TREE_OUTCOMES.tree;
        },
        probeLiveness: () => EXECUTOR_LIVENESS.dead,
        teardownTree: async () => settledTeardown(),
      },
    );
    assert.deepEqual(killedPids, [4242]);
    assert.equal(result.killed, true);
    assert.equal(result.previousStatus, INVOCATION_STATUSES.running);
    assert.equal(result.invocation.status, INVOCATION_STATUSES.failed);
    assert.equal(result.invocation.error, "已由用户取消");
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelScheduledInvocation --kill 档：进程树未在限时内退出则不取消", async () => {
  const dir = tempDir();
  const harness = createClaimedInvocation(dir);
  try {
    harness.setLiveness(EXECUTOR_LIVENESS.alive);
    harness.store.beginInvocation(harness.invocation.id, harness.ownershipToken, DUE, {
      pid: 4242,
      startToken: "boot-token",
    });
    await assert.rejects(
      cancelScheduledInvocation(
        { store: harness.store, invocationId: harness.invocation.id, kill: true },
        {
          terminateExecutor: async () => KILL_PROCESS_TREE_OUTCOMES.tree,
          probeLiveness: () => EXECUTOR_LIVENESS.alive,
          teardownTree: async () => settledTeardown(),
          killConfirmTimeoutMs: 150,
          killConfirmPollMs: 10,
        },
      ),
      /未全部退出/u,
    );
    assert.equal(
      harness.store.getInvocation(harness.invocation.id)?.status,
      INVOCATION_STATUSES.running,
    );
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelScheduledInvocation 在 attempt 变化（被接管）时拒绝改写账本", async () => {
  const dir = tempDir();
  const harness = createClaimedInvocation(dir);
  try {
    let reads = 0;
    const wrapped = {
      getInvocation: (id: string) => {
        const record = harness.store.getInvocation(id);
        reads += 1;
        if (record !== undefined && reads >= 2) {
          return { ...record, attempt: record.attempt + 1 };
        }
        return record;
      },
      finalizeCancellation: harness.store.finalizeCancellation.bind(harness.store),
    };
    await assert.rejects(
      cancelScheduledInvocation({
        store: wrapped,
        invocationId: harness.invocation.id,
        kill: false,
      }),
      /已被其他 worker 接管/u,
    );
    assert.equal(
      harness.store.getInvocation(harness.invocation.id)?.status,
      INVOCATION_STATUSES.claimed,
    );
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
