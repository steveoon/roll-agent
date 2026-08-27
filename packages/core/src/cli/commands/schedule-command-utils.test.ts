import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeUnsettledTree,
  formatInvocationLine,
  formatScheduleLine,
  liveRunHint,
  type SerializedInvocation,
  type SerializedSchedule,
} from "./schedule-command-utils.ts";

const invocation: SerializedInvocation = {
  id: "inv-1",
  scheduleId: "s-1",
  mode: "scheduled",
  status: "running",
  scheduledFor: "2026-08-27T09:00:00.000Z",
  attempt: 2,
  maxAttempts: 3,
  executorPid: 4242,
  threadId: undefined,
  error: undefined,
  pendingActions: [],
  outputExcerpt: undefined,
  treeUnsettled: false,
  treeSurvivorPids: [],
  treeTrackedGroups: [],
  startedAt: "2026-08-27T09:00:01.000Z",
  finishedAt: undefined,
};

const schedule: SerializedSchedule = {
  id: "s-1",
  name: "汇总",
  status: "active",
  trigger: "每 1 小时",
  cwd: "/tmp/x",
  prompt: "p",
  nextRunAt: "2026-08-27T10:00:00.000Z",
  lastRunAt: undefined,
  lastError: undefined,
  authorityDigest: undefined,
  createdAt: "2026-08-27T08:00:00.000Z",
};

test("describeUnsettledTree：只有 treeUnsettled 才有输出，带 survivor pid", () => {
  assert.equal(describeUnsettledTree(invocation), undefined);
  assert.equal(
    describeUnsettledTree({ treeUnsettled: true, treeSurvivorPids: [] }),
    "tree=unsettled",
  );
  assert.equal(
    describeUnsettledTree({ treeUnsettled: true, treeSurvivorPids: [7, 9] }),
    "tree=unsettled(pid 7, 9)",
  );
});

test("formatInvocationLine：hold 住的 running 行显示未清树与原因", () => {
  const plain = formatInvocationLine(invocation);
  assert.equal(plain.includes("tree="), false);
  const held = formatInvocationLine({
    ...invocation,
    treeUnsettled: true,
    treeSurvivorPids: [7, 9],
    error: "本次运行拉起的进程在强制终止后仍存活（pid 7, 9）",
  });
  assert.match(held, /^running {13}2026-08-27T09:00:00.000Z {2}attempt=2 {2}thread=-/u);
  assert.match(held, /tree=unsettled\(pid 7, 9\)/u);
  assert.match(held, /仍存活（pid 7, 9）$/u);
});

test("liveRunHint：无 live run / 树已清返回 undefined；未清树返回 held；读取失败返回 unreadable", () => {
  const record = (overrides: Partial<{ treeUnsettled: boolean }>) =>
    ({
      id: "inv-1",
      status: "retry",
      treeUnsettled: false,
      treeSurvivorPids: [7],
      ...overrides,
    }) as never;
  assert.equal(liveRunHint({ findLiveRun: () => undefined }, "s-1"), undefined);
  assert.equal(liveRunHint({ findLiveRun: () => record({}) }, "s-1"), undefined);
  assert.deepEqual(liveRunHint({ findLiveRun: () => record({ treeUnsettled: true }) }, "s-1"), {
    kind: "held",
    invocationId: "inv-1",
    status: "retry",
    survivorPids: [7],
  });
  assert.deepEqual(
    liveRunHint(
      {
        findLiveRun: () => {
          throw new Error("进程树所有权元数据无效");
        },
      },
      "s-1",
    ),
    { kind: "unreadable", message: "进程树所有权元数据无效" },
  );
});

test("formatScheduleLine：hold 住的任务在 list 里给出 invocation id 与 cancel --kill 提示", () => {
  const base = formatScheduleLine(schedule);
  assert.equal(base, "s-1  active  每 1 小时      next=2026-08-27T10:00:00.000Z  汇总");
  const held = formatScheduleLine(schedule, {
    kind: "held",
    invocationId: "inv-1",
    status: "running",
    survivorPids: [7, 9],
  });
  assert.ok(held.startsWith(base));
  assert.match(held, /⚠ 运行 inv-1（running）进程树未清，残留 pid 7, 9；任务不再触发/u);
  assert.match(held, /roll schedule cancel inv-1 --kill/u);
  const unreadable = formatScheduleLine(schedule, { kind: "unreadable", message: "坏了" });
  assert.equal(unreadable, `${base}  ⚠ 坏了`);
  const paused = formatScheduleLine({ ...schedule, status: "paused", lastError: "权限漂移" });
  assert.match(paused, /paused .*⚠ 权限漂移$/u);
});
