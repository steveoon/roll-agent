import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  INVOCATION_TREE_TEARDOWN_OUTCOMES,
  ProcessGroupLedger,
  collectTreeMembers,
  invocationMarker,
  parseProcStat,
  parsePsSnapshot,
  snapshotProcesses,
  terminateInvocationTree,
  type ProcessSnapshot,
} from "./invocation-tree.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const MARKER = invocationMarker(ID);

test("parsePsSnapshot 解析 pid/pgid/stat/command 并按边界匹配标记、排除指定 pid", () => {
  const output = [
    "  100   100 Ss   /bin/bash -c sleep",
    `  101   100 S    /opt/homebrew/bin/node -e x PATH=/usr/bin ${MARKER} HOME=/Users/x`,
    `  102   102 Z    (node) ${MARKER}`,
    `  103   103 S    /usr/bin/python3 ${MARKER}0`,
    "  104   104 R+   /bin/ps -A -ww -o pid=,pgid=,stat=,command= -E",
    "garbage line",
  ].join("\n");
  assert.deepEqual(parsePsSnapshot(output, MARKER, 104), [
    { pid: 100, pgid: 100, zombie: false, marked: false },
    { pid: 101, pgid: 100, zombie: false, marked: true },
    { pid: 102, pgid: 102, zombie: true, marked: true },
    { pid: 103, pgid: 103, zombie: false, marked: false },
  ]);
});

test("parseProcStat 取 ')' 之后的 state 与 pgrp，comm 含空格和括号也不受影响", () => {
  assert.deepEqual(parseProcStat("101 (node (x) y) S 1 100 100 0 -1 4194560 0"), {
    pgid: 100,
    zombie: false,
  });
  assert.deepEqual(parseProcStat("102 (sleep) Z 1 102 102 0"), { pgid: 102, zombie: true });
  assert.equal(parseProcStat("broken"), undefined);
});

test("invocationMarker 形如 ROLL_SCHEDULE_INVOCATION=<id>", () => {
  assert.equal(MARKER, `ROLL_SCHEDULE_INVOCATION=${ID}`);
});

function snapshot(
  entries: readonly (readonly [number, number, boolean?, boolean?])[],
): ProcessSnapshot {
  return entries.map(([pid, pgid, marked = false, zombie = false]) => ({
    pid,
    pgid,
    marked,
    zombie,
  }));
}

test("collectTreeMembers：标记进程无论在哪个组都算成员，自身与僵尸排除", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500, true],
      [501, 501, true],
      [502, 900, true],
      [503, 903, true, true],
      [504, 904],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [] },
  );
  assert.deepEqual(members, { pids: [501, 502], skippedReusedGroups: [] });
});

test("collectTreeMembers：exec 是组首领时同组成员算成员；不是首领时不启用组判据", () => {
  const leader = collectTreeMembers(
    snapshot([
      [500, 500],
      [510, 500],
      [511, 500, false, true],
      [520, 520],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [] },
  );
  assert.deepEqual(leader.pids, [510]);
  const notLeader = collectTreeMembers(
    snapshot([
      [500, 1],
      [510, 1],
      [520, 520],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [] },
  );
  assert.deepEqual(notLeader.pids, []);
});

test("collectTreeMembers：登记组首领存活或已退出且 pid 未复用时整组算成员；pid 已被复用则跳过", () => {
  const alive = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => false }] },
  );
  assert.deepEqual(alive.pids, [600, 601]);
  const orphaned = collectTreeMembers(
    snapshot([
      [500, 500],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(orphaned, { pids: [601], skippedReusedGroups: [] });
  const reused = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [600] });
  const zombieLeader = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600, false, true],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(zombieLeader.pids, [601]);
});

test("collectTreeMembers：上一任 executor pid 当作已退出的登记组处理", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500],
      [701, 700],
      [702, 700, true],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [], previousExecutorPid: 700 },
  );
  assert.deepEqual(members.pids, [701, 702]);
  const reused = collectTreeMembers(
    snapshot([
      [500, 500],
      [700, 700],
      [701, 700],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [], previousExecutorPid: 700 },
  );
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [700] });
});

test("ProcessGroupLedger 只登记拿到 pid 的子进程，leaderExited 跟随 exitCode/signalCode", () => {
  const ledger = new ProcessGroupLedger();
  const child = {
    pid: 800,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  };
  ledger.track({ pid: undefined, exitCode: null, signalCode: null });
  ledger.track(child);
  assert.equal(ledger.groups().length, 1);
  assert.equal(ledger.groups()[0]?.pgid, 800);
  assert.equal(ledger.groups()[0]?.leaderExited(), false);
  child.exitCode = 0;
  assert.equal(ledger.groups()[0]?.leaderExited(), true);
});

function scriptedDeps(
  frames: readonly ProcessSnapshot[],
  killed: Array<[number, string]>,
  extra: {
    readonly graceMs?: number;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
) {
  let index = 0;
  let clock = 0;
  return {
    platform: "darwin" as const,
    snapshot: () => frames[Math.min(index++, frames.length - 1)],
    kill:
      extra.kill ??
      ((pid: number, signal: NodeJS.Signals) => {
        killed.push([pid, signal]);
      }),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    graceMs: extra.graceMs ?? 0,
    pollMs: 10,
  };
}

const SCOPE = { invocationId: ID, selfPid: 500, trackedGroups: [] as const };

test("terminateInvocationTree：没有成员直接 clean，不发信号", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([snapshot([[500, 500]])], killed),
  );
  assert.deepEqual(report, {
    outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.clean,
    terminatedPids: [],
    survivorPids: [],
    skippedReusedGroups: [],
  });
  assert.deepEqual(killed, []);
});

test("terminateInvocationTree：SIGTERM 后成员消失即 clean，不再 SIGKILL", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps(
      [
        snapshot([
          [500, 500],
          [501, 501, true],
        ]),
        snapshot([[500, 500]]),
      ],
      killed,
    ),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [501]);
  assert.deepEqual(killed, [[501, "SIGTERM"]]);
});

test("terminateInvocationTree：grace 后仍在则 SIGKILL，随后消失为 clean", async () => {
  const killed: Array<[number, string]> = [];
  const alive = snapshot([
    [500, 500],
    [501, 501, true],
  ]);
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([alive, alive, snapshot([[500, 500]])], killed),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(killed, [
    [501, "SIGTERM"],
    [501, "SIGKILL"],
  ]);
});

test("terminateInvocationTree：SIGKILL 后仍在或 EPERM 的进程记为 survivors", async () => {
  const killed: Array<[number, string]> = [];
  const stuck = snapshot([
    [500, 500],
    [501, 501, true],
    [502, 500],
  ]);
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([stuck, stuck, stuck], killed, {
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        if (pid === 502) {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
      },
    }),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors);
  assert.deepEqual(report.survivorPids, [501, 502]);
  assert.deepEqual(report.terminatedPids, []);
});

test("terminateInvocationTree：ESRCH 忽略；快照不可用返回 unavailable；win32 返回 unsupported", async () => {
  const killed: Array<[number, string]> = [];
  const esrch = await terminateInvocationTree(
    SCOPE,
    scriptedDeps(
      [
        snapshot([
          [500, 500],
          [501, 501, true],
        ]),
        snapshot([[500, 500]]),
      ],
      killed,
      {
        kill: () => {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        },
      },
    ),
  );
  assert.equal(esrch.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  const unavailable = await terminateInvocationTree(SCOPE, {
    ...scriptedDeps([], killed),
    snapshot: () => undefined,
  });
  assert.equal(unavailable.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  const unsupported = await terminateInvocationTree(SCOPE, { platform: "win32" });
  assert.equal(unsupported.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported);
});

test("terminateInvocationTree：清场途中新出现的成员也会被处理并计入 terminatedPids", async () => {
  const killed: Array<[number, string]> = [];
  const frames = [
    snapshot([
      [500, 500],
      [501, 501, true],
    ]),
    snapshot([
      [500, 500],
      [503, 503, true],
    ]),
    snapshot([[500, 500]]),
  ];
  const report = await terminateInvocationTree(SCOPE, scriptedDeps(frames, killed));
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [501, 503]);
  assert.deepEqual(killed, [
    [501, "SIGTERM"],
    [503, "SIGKILL"],
  ]);
});

const posixOnly = { skip: process.platform === "win32" };

test(
  "真实进程：带标记的 detached 子进程被找到并终止，不同标记的对照进程不受影响",
  posixOnly,
  async () => {
    const otherId = "99999999-8888-4777-8666-555555555555";
    const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ROLL_SCHEDULE_INVOCATION: ID },
    });
    const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ROLL_SCHEDULE_INVOCATION: otherId },
    });
    try {
      await Promise.all([once(target, "spawn"), once(control, "spawn")]);
      const targetExit = once(target, "exit");
      const report = await terminateInvocationTree({
        invocationId: ID,
        selfPid: process.pid,
        trackedGroups: [],
      });
      await targetExit;
      assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
      assert.ok(report.terminatedPids.includes(target.pid ?? -1));
      assert.equal(control.exitCode, null);
      assert.equal(control.signalCode, null);
    } finally {
      control.kill("SIGKILL");
      await once(control, "exit").catch(() => undefined);
      if (target.exitCode === null && target.signalCode === null) {
        target.kill("SIGKILL");
      }
    }
  },
);

test(
  "真实进程：bash 工具形状的孤儿（sh 退出后留在其进程组的 /bin/sleep）经登记组被找到并终止",
  posixOnly,
  async () => {
    const ledger = new ProcessGroupLedger();
    const shell = spawn("/bin/sh", ["-c", "/bin/sleep 60 & exit 0"], {
      detached: true,
      stdio: "ignore",
    });
    ledger.track(shell);
    await once(shell, "exit");
    const scope = { invocationId: ID, selfPid: process.pid, trackedGroups: ledger.groups() };
    const before = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
    assert.equal(before.pids.length, 1, "sh 退出后应留下一个孤儿 sleep");
    const report = await terminateInvocationTree(scope);
    assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
    assert.deepEqual(report.terminatedPids, before.pids);
    const after = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
    assert.deepEqual(after.pids, []);
  },
);

test("真实进程：测试进程不是组首领时不会误杀同组进程", posixOnly, async () => {
  const sibling = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  try {
    await once(sibling, "spawn");
    const snap = snapshotProcesses(invocationMarker(ID));
    assert.ok(snap);
    const self = snap.find((entry) => entry.pid === process.pid);
    assert.ok(self);
    if (self.pgid === process.pid) {
      return;
    }
    const report = await terminateInvocationTree({
      invocationId: ID,
      selfPid: process.pid,
      trackedGroups: [],
    });
    assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
    assert.equal(report.terminatedPids.includes(sibling.pid ?? -1), false);
    assert.equal(sibling.exitCode, null);
  } finally {
    sibling.kill("SIGKILL");
    await once(sibling, "exit").catch(() => undefined);
  }
});

test(
  "真实进程：快照里带标记的只有那个子进程，不含做快照的 ps，测试进程自身在快照里",
  posixOnly,
  async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ROLL_SCHEDULE_INVOCATION: ID },
    });
    try {
      await once(child, "spawn");
      const snap = snapshotProcesses(invocationMarker(ID));
      assert.ok(snap);
      assert.deepEqual(
        snap.filter((entry) => entry.marked).map((entry) => entry.pid),
        [child.pid],
      );
      assert.equal(
        snap.some((entry) => entry.pid === process.pid),
        true,
      );
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
  },
);
