import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ScheduleBrowserController,
  type ScheduleBrowserPort,
  type ScheduleTaskItem,
} from "./schedule-browser.ts";

const TASK: ScheduleTaskItem = {
  id: "task",
  name: "每日检查",
  trigger: "每天",
  status: "active",
  removed: false,
};

function fixture(overrides: Partial<ScheduleBrowserPort> = {}): {
  readonly port: ScheduleBrowserPort;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const port: ScheduleBrowserPort = {
    async listTasks() {
      calls.push("tasks");
      return [TASK];
    },
    async listRuns(id, page) {
      calls.push(`runs:${id}:${page.cursor ?? "first"}:${String(page.limit)}`);
      return {
        items: [
          {
            id: "run",
            scheduledAt: "今天",
            mode: "scheduled",
            status: "completed",
            attempts: [1, 2],
          },
        ],
        ...(page.cursor === undefined ? { nextCursor: "second" } : {}),
      };
    },
    async inspect(id, attempt = 2) {
      calls.push(`inspect:${id}:${String(attempt)}`);
      return {
        invocationId: id,
        taskName: TASK.name,
        attempt,
        attempts: [1, 2],
        cwd: "/old",
        mode: "scheduled",
        status: "completed",
        sessionId: `s${String(attempt)}`,
        canContinue: true,
      };
    },
    async readTranscript(id, page) {
      calls.push(`transcript:${id}:${String(page.attempt)}:${page.cursor ?? "first"}`);
      return {
        text: "user: 原始消息\ntool: 完整证据",
        ...(page.cursor === undefined ? { nextCursor: "older" } : {}),
      };
    },
    async continueRun() {
      calls.push("continue");
      throw new Error("无法创建会话");
    },
    ...overrides,
  };
  return { port, calls };
}

test("schedule browser navigates grouped runs, pages and attempt snapshots without creating a session", async () => {
  const { port, calls } = fixture();
  const browser = new ScheduleBrowserController(port);
  await browser.refresh();
  await browser.choose("task");
  await browser.page(1);
  await browser.page(-1);
  await browser.choose("run");
  assert.equal(browser.getSnapshot().view.kind, "detail");
  await browser.page(1);
  await browser.changeAttempt(-1);
  await browser.refresh();
  const view = browser.getSnapshot().view;
  assert.equal(view.kind, "detail");
  if (view.kind !== "detail") assert.fail();
  assert.equal(view.detail.attempt, 1);
  assert.deepEqual(view.cursors, [undefined]);
  assert.match(view.page.text, /完整证据/);
  assert.ok(calls.includes("runs:task:second:20"));
  assert.ok(calls.includes("transcript:run:2:older"));
  assert.equal(calls.includes("continue"), false);
  assert.equal(browser.back(), true);
  assert.equal(browser.getSnapshot().view.kind, "runs");
  assert.equal(browser.back(), true);
  assert.equal(browser.getSnapshot().view.kind, "tasks");
  assert.equal(browser.back(), false);
});

test("continue failure keeps the detail and blocks duplicate continuation until it settles", async () => {
  const pending = Promise.withResolvers<never>();
  let continuations = 0;
  const { port } = fixture({
    async continueRun() {
      continuations++;
      return pending.promise;
    },
  });
  const browser = new ScheduleBrowserController(port);
  await browser.refresh();
  await browser.choose("task");
  await browser.choose("run");
  const continuing = browser.continueRun();
  assert.equal(await browser.continueRun(), undefined);
  assert.equal(browser.back(), true);
  assert.equal(browser.getSnapshot().view.kind, "detail");
  pending.reject(new Error("目标数据库不可写"));
  assert.equal(await continuing, undefined);
  assert.equal(continuations, 1);
  assert.equal(browser.getSnapshot().view.kind, "detail");
  assert.equal(browser.getSnapshot().error, "目标数据库不可写");
  assert.equal(browser.getSnapshot().busy, false);
});

test("Esc during a read discards stale detail and preserves the parent screen", async () => {
  const pending =
    Promise.withResolvers<
      ReturnType<ScheduleBrowserPort["inspect"]> extends Promise<infer T> ? T : never
    >();
  const { port } = fixture({ inspect: async () => pending.promise });
  const browser = new ScheduleBrowserController(port);
  await browser.refresh();
  await browser.choose("task");
  const reading = browser.choose("run");
  assert.equal(browser.back(), true);
  pending.resolve({
    invocationId: "run",
    taskName: TASK.name,
    attempt: 1,
    attempts: [1],
    cwd: "/old",
    mode: "scheduled",
    status: null,
    canContinue: false,
    unavailableReason: "会话未创建",
  });
  await reading;
  assert.equal(browser.getSnapshot().view.kind, "tasks");
  assert.equal(browser.getSnapshot().busy, false);
});

test("missing execution session remains inspectable and cannot be continued", async () => {
  const { port, calls } = fixture({
    async inspect() {
      return {
        invocationId: "run",
        taskName: TASK.name,
        attempt: 1,
        attempts: [1],
        cwd: "/old",
        mode: "scheduled",
        status: "failed",
        canContinue: false,
        unavailableReason: "会话未创建",
      };
    },
  });
  const browser = new ScheduleBrowserController(port);
  await browser.refresh();
  await browser.choose("task");
  await browser.choose("run");
  const view = browser.getSnapshot().view;
  assert.equal(view.kind, "detail");
  if (view.kind !== "detail") assert.fail();
  assert.equal(view.page.text, "会话未创建");
  assert.equal(await browser.continueRun(), undefined);
  assert.equal(
    calls.some((call) => call.startsWith("transcript") || call === "continue"),
    false,
  );
});
