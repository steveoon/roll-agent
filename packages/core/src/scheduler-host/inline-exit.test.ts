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
import {
  INLINE_EXIT_DECISIONS,
  armInlineRunTimeout,
  createInlineStopForwarder,
  decideInlineExit,
  inlineProcessExitCode,
  isInlineTerminalSuccess,
  settleInlineAfterExit,
  settleInlineInvocation,
  waitForInlineRootExit,
} from "./inline-exit.ts";

test("inline max-run 到期复用 stop forwarder 的 SIGTERM → grace → SIGKILL 语义", async () => {
  const signals: string[] = [];
  const timeouts: number[] = [];
  const forwarder = createInlineStopForwarder(
    {
      kill: (signal) => {
        signals.push(signal);
        return "tree-terminated";
      },
    },
    "linux",
    10,
  );
  const clearRunTimeout = armInlineRunTimeout(20, () => {
    timeouts.push(20);
    forwarder.forward();
  });

  const deadline = Date.now() + 1_000;
  while (signals.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  clearRunTimeout();
  forwarder.seal();

  assert.deepEqual(timeouts, [20]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("inline exec 先退出时取消 max-run timer，不向已结束进程发送迟到信号", async () => {
  const signals: string[] = [];
  const forwarder = createInlineStopForwarder(
    {
      kill: (signal) => {
        signals.push(signal);
        return "tree-terminated";
      },
    },
    "linux",
    10,
  );
  const clearRunTimeout = armInlineRunTimeout(20, forwarder.forward);

  clearRunTimeout();
  forwarder.seal();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(signals, []);
});

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
    INLINE_EXIT_DECISIONS.fail,
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
    INLINE_EXIT_DECISIONS.holdUnverifiedLiveness,
  );
  assert.equal(
    decideInlineExit({ killOutcome: "tree-terminated", liveness: "alive" }),
    INLINE_EXIT_DECISIONS.holdUnverifiedLiveness,
  );
});

test("inline 最终成功状态只包括 completed 与 needs_confirmation", () => {
  assert.equal(isInlineTerminalSuccess(INVOCATION_STATUSES.completed), true);
  assert.equal(isInlineTerminalSuccess(INVOCATION_STATUSES.needsConfirmation), true);
  assert.equal(isInlineTerminalSuccess(INVOCATION_STATUSES.running), false);
  assert.equal(isInlineTerminalSuccess(INVOCATION_STATUSES.retry), false);
  assert.equal(isInlineTerminalSuccess(undefined), false);
});

test("inline 进程退出码只在最终账本状态非成功时为 1", () => {
  assert.equal(inlineProcessExitCode(INVOCATION_STATUSES.completed), 0);
  assert.equal(inlineProcessExitCode(INVOCATION_STATUSES.needsConfirmation), 0);
  assert.equal(inlineProcessExitCode(INVOCATION_STATUSES.running), 1);
  assert.equal(inlineProcessExitCode(INVOCATION_STATUSES.retry), 1);
  assert.equal(inlineProcessExitCode(undefined), 1);
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
  outcomes.push("failed");
  posix.escalate();
  assert.equal(posix.killOutcome(), "tree-terminated");
  posix.seal();
  posix.forward();
  posix.escalate();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGKILL"]);
  const windows = createInlineStopForwarder(handle, "win32");
  windows.forward();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGKILL", "SIGKILL"]);
});

test("inline POSIX 首次停止会在 grace 后自动 SIGKILL，seal 会取消迟到升级", async () => {
  const escalatedSignals: string[] = [];
  const escalated = createInlineStopForwarder(
    {
      kill: (signal) => {
        escalatedSignals.push(signal);
        return "tree-terminated";
      },
    },
    "linux",
    10,
  );
  escalated.forward();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(escalatedSignals, ["SIGTERM", "SIGKILL"]);

  const sealedSignals: string[] = [];
  const sealed = createInlineStopForwarder(
    {
      kill: (signal) => {
        sealedSignals.push(signal);
        return "tree-terminated";
      },
    },
    "darwin",
    10,
  );
  sealed.forward();
  sealed.seal();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(sealedSignals, ["SIGTERM"]);
});

test("inline root exit 监听 reject 时身份未知，立即 seal 而不等待 numeric-PGID 升级", async () => {
  const signals: string[] = [];
  const forwarder = createInlineStopForwarder(
    {
      kill: (signal) => {
        signals.push(signal);
        return "tree-terminated";
      },
    },
    "linux",
    10,
  );
  forwarder.forward();

  await assert.rejects(
    waitForInlineRootExit(Promise.reject(new Error("exit observer failed")), forwarder),
    /observer failed/u,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(signals, ["SIGTERM"]);
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

test("inline root 退出后只有 grace 到期时仍有后代才发 SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const liveness: Array<"descendants-alive" | "dead"> = [
      "descendants-alive",
      "descendants-alive",
      "dead",
    ];
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      executorLiveness: () => liveness.shift() ?? "dead",
    });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();

    const decision = await settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });

    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(decision, INLINE_EXIT_DECISIONS.fail);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后 grace 到期前树已非 descendants 时不发 SIGKILL", async () => {
  for (const nextLiveness of ["dead", "unknown", "alive"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
    try {
      let probes = 0;
      const store = new ScheduleStore(dir, {
        executorLiveness: () => (probes++ === 0 ? "descendants-alive" : nextLiveness),
      });
      const running = seedRunningInvocation(store);
      const signals: string[] = [];
      const forwarder = createInlineStopForwarder(
        {
          kill: (signal) => {
            signals.push(signal);
            return "tree-terminated";
          },
        },
        "linux",
        10,
      );
      forwarder.forward();

      const decision = await settleInlineAfterExit({
        store,
        forwarder,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        expectedAttempt: 1,
        exitCode: null,
      });

      assert.deepEqual(signals, ["SIGTERM"], nextLiveness);
      assert.equal(decision, INLINE_EXIT_DECISIONS.holdDescendants, nextLiveness);
      assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("inline root 退出后 grace 到期前探活抛错时不发 SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    let probes = 0;
    const store = new ScheduleStore(dir, {
      executorLiveness: () => {
        if (probes++ === 0) {
          return "descendants-alive";
        }
        throw new Error("probe unavailable during grace");
      },
    });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();

    assert.equal(
      await settleInlineAfterExit({
        store,
        forwarder,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        expectedAttempt: 1,
        exitCode: null,
      }),
      INLINE_EXIT_DECISIONS.holdDescendants,
    );

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后的再次 forward 在 SIGTERM 前重新确认仍有 descendants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const liveness: Array<"descendants-alive" | "dead"> = ["descendants-alive", "dead"];
    const store = new ScheduleStore(dir, {
      executorLiveness: () => liveness.shift() ?? "dead",
    });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      30,
    );
    forwarder.forward();

    const settling = settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });
    forwarder.forward();

    assert.equal(await settling, INLINE_EXIT_DECISIONS.holdDescendants);
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后的再次 forward 会等待新 grace，后代持续存活时仍 SIGKILL 并结算", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const liveness: Array<"descendants-alive" | "dead"> = [
      "descendants-alive",
      "descendants-alive",
      "descendants-alive",
      "dead",
    ];
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      executorLiveness: () => liveness.shift() ?? "dead",
    });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();

    const settling = settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });
    forwarder.forward();

    assert.equal(await settling, INLINE_EXIT_DECISIONS.fail);
    assert.deepEqual(signals, ["SIGTERM", "SIGTERM", "SIGKILL"]);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后的 Ctrl-C 升级在 SIGKILL 前重新确认仍有 descendants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const liveness: Array<"descendants-alive" | "dead"> = ["descendants-alive", "dead"];
    const store = new ScheduleStore(dir, {
      executorLiveness: () => liveness.shift() ?? "dead",
    });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      30,
    );
    forwarder.forward();

    const settling = settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });
    forwarder.escalate();

    assert.equal(await settling, INLINE_EXIT_DECISIONS.holdDescendants);
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline SIGKILL 早于 root-exit 结算完成时仍记住已升级，必须复探 tree-dead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const liveness: Array<"descendants-alive" | "dead"> = ["descendants-alive", "dead"];
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      executorLiveness: () => liveness.shift() ?? "dead",
    });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const decision = await settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });

    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(decision, INLINE_EXIT_DECISIONS.fail);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后探活 unknown 取消 numeric-PGID 升级，账本 fail-closed 保持 running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "unknown" });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();

    const decision = await settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(decision, INLINE_EXIT_DECISIONS.holdUnverifiedLiveness);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后探活仍报 alive 时不对可能复用的 numeric PGID 升级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "alive" });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();

    const decision = await settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(decision, INLINE_EXIT_DECISIONS.holdUnverifiedLiveness);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后读账本抛错等价 unknown，立即 seal 而不发迟到 SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir);
    const running = seedRunningInvocation(store);
    const originalGetInvocation = store.getInvocation.bind(store);
    store.getInvocation = () => {
      throw new Error("ledger unavailable");
    };
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();

    await assert.rejects(
      settleInlineAfterExit({
        store,
        forwarder,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        expectedAttempt: 1,
        exitCode: null,
      }),
      /ledger unavailable/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    store.getInvocation = originalGetInvocation;
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后 executor 探活抛错等价 unknown，不对 numeric PGID 升级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir);
    const running = seedRunningInvocation(store);
    store.probeExecutor = () => {
      throw new Error("probe unavailable");
    };
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      10,
    );
    forwarder.forward();

    await assert.rejects(
      settleInlineAfterExit({
        store,
        forwarder,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        expectedAttempt: 1,
        exitCode: null,
      }),
      /probe unavailable/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline root 退出后已证明 tree dead 时才 seal，取消迟到 SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1, executorLiveness: () => "dead" });
    const running = seedRunningInvocation(store);
    const signals: string[] = [];
    const forwarder = createInlineStopForwarder(
      {
        kill: (signal) => {
          signals.push(signal);
          return "tree-terminated";
        },
      },
      "linux",
      30,
    );
    forwarder.forward();

    const decision = await settleInlineAfterExit({
      store,
      forwarder,
      invocationId: running.id,
      ownershipToken: running.ownershipToken,
      expectedAttempt: 1,
      exitCode: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(decision, INLINE_EXIT_DECISIONS.fail);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline 结算：后代存活或探活 unknown 时保留 running；dead 即使先前 kill failed 也可结算", () => {
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
        expectedAttempt: 1,
        killOutcome,
        exitCode: null,
      });
    assert.equal(settle(undefined), INLINE_EXIT_DECISIONS.holdDescendants);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    liveness = "unknown";
    assert.equal(settle("tree-terminated"), INLINE_EXIT_DECISIONS.holdUnverifiedLiveness);
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    liveness = "dead";
    assert.equal(settle("failed"), INLINE_EXIT_DECISIONS.fail);
    assert.notEqual(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    assert.match(store.getInvocation(running.id)?.error ?? "", /exec 进程退出 code=null/u);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline 结算：failInvocation 因树未清返回 treeUnsettled 时改为 hold，不 pause", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      executorLiveness: () => "dead",
    });
    const running = seedRunningInvocation(store);
    assert.equal(
      store.recordInvocationTree({
        id: running.id,
        ownershipToken: running.ownershipToken,
        trackedGroups: [{ pgid: 9001, leaderState: "unknown" }],
        unsettled: true,
        survivorPids: [9002],
      }),
      true,
    );
    assert.equal(
      settleInlineInvocation({
        store,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        expectedAttempt: 1,
        killOutcome: "tree-terminated",
        exitCode: 1,
      }),
      INLINE_EXIT_DECISIONS.holdUnverifiedLiveness,
    );
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
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
        expectedAttempt: 1,
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

test("inline max-run 已触发时，finishedAt >= timedOutAt 的成功终态仍重分类为超时失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      executorLiveness: () => "dead",
    });
    const running = seedRunningInvocation(store);
    assert.equal(
      store.completeInvocation({
        id: running.id,
        ownershipToken: running.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: Date.now(),
        threadId: "late-success",
      }),
      "written",
    );

    assert.equal(
      settleInlineInvocation({
        store,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        expectedAttempt: 1,
        killOutcome: "failed",
        exitCode: 0,
        timeoutError: "inline 运行超过 60000 ms",
        timedOutAtMs: 0,
      }),
      INLINE_EXIT_DECISIONS.fail,
    );
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getInvocation(running.id)?.error, "inline 运行超过 60000 ms");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline 退出事件迟到时保留 timedOutAt 前已写入的 completed 并结束而非 hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      executorLiveness: () => "dead",
    });
    const running = seedRunningInvocation(store);
    const finishedAtMs = Date.now();
    assert.equal(
      store.completeInvocation({
        id: running.id,
        ownershipToken: running.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: finishedAtMs,
        threadId: "on-time-success",
      }),
      "written",
    );

    assert.equal(
      settleInlineInvocation({
        store,
        invocationId: running.id,
        ownershipToken: running.ownershipToken,
        expectedAttempt: 1,
        killOutcome: "failed",
        exitCode: 0,
        timeoutError: "inline 运行超过 60000 ms",
        timedOutAtMs: finishedAtMs + 1,
      }),
      INLINE_EXIT_DECISIONS.fail,
    );
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.completed);
    assert.equal(store.getInvocation(running.id)?.threadId, "on-time-success");
    assert.equal(inlineProcessExitCode(store.getInvocation(running.id)?.status), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline timeout 只能用原 claim attempt CAS，不改写后续 attempt 的成功结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-inline-exit-"));
  try {
    const store = new ScheduleStore(dir, { retryBackoffMs: 1, executorLiveness: () => "dead" });
    const first = seedRunningInvocation(store);
    const firstFailedAt = Date.now();
    assert.equal(
      store.failInvocation(first.id, first.ownershipToken, "first attempt failed", firstFailedAt),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const second = store.claimDue({
      workerId: "next-daemon",
      nowMs: firstFailedAt + 2,
      limit: 1,
    })[0];
    assert.ok(second);
    assert.equal(second.invocation.attempt, 2);
    assert.equal(
      store.completeInvocation({
        id: first.id,
        ownershipToken: second.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: firstFailedAt + 3,
        threadId: "attempt-2-success",
      }),
      "written",
    );

    assert.equal(
      settleInlineInvocation({
        store,
        invocationId: first.id,
        ownershipToken: first.ownershipToken,
        expectedAttempt: 1,
        killOutcome: "failed",
        exitCode: 0,
        timeoutError: "attempt 1 max-run timeout",
        timedOutAtMs: firstFailedAt,
      }),
      INLINE_EXIT_DECISIONS.fail,
    );
    assert.equal(store.getInvocation(first.id)?.status, INVOCATION_STATUSES.completed);
    assert.equal(store.getInvocation(first.id)?.threadId, "attempt-2-success");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
