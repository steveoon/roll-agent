import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import type { AgentSession } from "@roll-agent/runtime";
import type { ScheduleBrowserPort } from "../schedule-browser.ts";
import { ChatApp } from "./app.ts";
import { ScheduleBrowser } from "./schedule-browser.ts";
import { displayWidth } from "./display-width.ts";

async function waitFor(check: () => void): Promise<void> {
  const end = Date.now() + 2000;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
      await delay(10);
    }
  }
}

function sessionFixture(
  id: string,
  text: string,
): { session: AgentSession; sent: string[]; closed: () => boolean } {
  const sent: string[] = [];
  let closed = false;
  return {
    sent,
    closed: () => closed,
    session: {
      id,
      getMessages: () => [{ role: "user", content: text }],
      getSkillSummaries: () => [],
      getContextWindow: () => undefined,
      setUserInputAvailable: () => {},
      send: (text: string) => {
        sent.push(text);
        return (async function* () {})();
      },
      close: async () => {
        closed = true;
      },
      cancel: () => false,
    } as unknown as AgentSession,
  };
}

test("/schedule keyboard navigation preserves chat; only successful Continue retires and switches the session", async () => {
  const prior = sessionFixture("prior", "原聊天内容");
  const fork = sessionFixture("fork", "从执行快照派生");
  let tasksRead = 0;
  let forkCalls = 0;
  let shouldFail = true;
  const submitted: string[] = [];
  const retired: string[] = [];
  const transcripts: number[] = [];
  const port: ScheduleBrowserPort = {
    async listTasks() {
      tasksRead++;
      return [{ id: "task", name: "每日检查", trigger: "每天", status: null, removed: true }];
    },
    async listRuns() {
      return {
        items: [
          {
            id: "run",
            scheduledAt: "今天",
            mode: "manual",
            status: "completed",
            excerpt: "发现更新",
            attempts: [1, 2],
          },
        ],
      };
    },
    async inspect(id, attempt = 2) {
      return {
        invocationId: id,
        taskName: "每日检查",
        cwd: "/original/project",
        mode: "scheduled",
        status: "completed",
        attempt,
        attempts: [1, 2],
        sessionId: `scheduled-${String(attempt)}`,
        canContinue: true,
      };
    },
    async readTranscript(_id, page) {
      transcripts.push(page.attempt);
      return { text: `用户：原始请求\n工具：完整归档证据\n助手：执行结果 ${String(page.attempt)}` };
    },
    async continueRun() {
      forkCalls++;
      if (shouldFail) throw new Error("创建失败");
      return fork.session;
    },
  };
  const ui = render(
    h(ChatApp, {
      session: prior.session,
      model: "current-model",
      initialHistory: [{ kind: "user", id: "old", text: "原聊天内容" }],
      onUserSubmit: (text) => submitted.push(text),
      onExit: () => {},
      sessionSwitching: {
        loadItems: () => [],
        resume: async () => prior.session,
        onRetired: (id) => retired.push(id),
      },
      scheduleBrowser: port,
    }),
  );
  const key = async (value: string): Promise<void> => {
    ui.stdin.write(value);
    await delay(30);
  };
  // Mouse-mode cleanup writes control-only frames after a viewport is unmounted.
  const frame = (): string =>
    ui.frames.findLast((value) => stripVTControlCharacters(value).trim().length > 0) ?? "";
  try {
    await delay(30);
    await key("/schedule");
    await key("\r");
    await waitFor(() => assert.match(ui.lastFrame() ?? "", /历史任务 · 每日检查/));
    assert.match(frame(), /已移除/);
    assert.doesNotMatch(frame(), /\bnull\b/);
    await key("r");
    await waitFor(() => assert.equal(tasksRead, 2));
    await key("\r");
    await waitFor(() => assert.match(ui.lastFrame() ?? "", /发现更新/));
    assert.match(frame(), /手动触发 · 成功/);
    assert.doesNotMatch(frame(), /\b(?:manual|completed)\b/);
    await key("\r");
    await waitFor(() => assert.match(ui.lastFrame() ?? "", /完整归档证据/));
    await key("[");
    await waitFor(() => assert.match(ui.lastFrame() ?? "", /执行结果 1/));
    await key("r");
    await waitFor(() => assert.deepEqual(transcripts, [2, 1, 1]));
    assert.deepEqual(submitted, []);
    assert.equal(forkCalls, 0);
    assert.equal(prior.closed(), false);
    await key("c");
    await waitFor(() => assert.match(ui.lastFrame() ?? "", /操作失败：创建失败/));
    assert.equal(prior.closed(), false);
    await key("\x1b");
    await waitFor(() => assert.match(frame(), /运行记录/));
    await key("\x1b");
    await waitFor(() => assert.match(frame(), /历史任务 · 每日检查/));
    await key("\x1b");
    await waitFor(() => assert.match(ui.lastFrame() ?? "", /原聊天内容/));
    assert.deepEqual(prior.sent, []);
    assert.deepEqual(retired, []);
    await key("/schedule");
    await key("\r");
    await waitFor(() => assert.match(frame(), /历史任务 · 每日检查/));
    await key("\r");
    await waitFor(() => assert.match(frame(), /发现更新/));
    await key("\r");
    await waitFor(() => assert.match(ui.lastFrame() ?? "", /完整归档证据/));
    shouldFail = false;
    await key("c");
    // New history renders before React's passive effect retires the previous session.
    await waitFor(() => {
      assert.match(frame(), /从执行快照派生/);
      assert.equal(prior.closed(), true);
      assert.deepEqual(retired, ["prior"]);
    });
    assert.deepEqual(fork.sent, []);
    assert.deepEqual(submitted, []);
    await key("继续分析");
    await key("\r");
    await waitFor(() => assert.deepEqual(fork.sent, ["继续分析"]));
    assert.deepEqual(prior.sent, []);
  } finally {
    ui.unmount();
  }
});

for (const { width, height } of [
  { width: 120, height: 30 },
  { width: 60, height: 18 },
  { width: 40, height: 9 },
]) {
  test(`snapshot primary action remains visible at ${String(width)}x${String(height)} and requires its explicit key`, async () => {
    const fork = sessionFixture("fork", "新对话");
    let forkCalls = 0;
    let finishCreating: (() => void) | undefined;
    const creating = new Promise<void>((resolve) => {
      finishCreating = resolve;
    });
    const continued: string[] = [];
    const port: ScheduleBrowserPort = {
      async listTasks() {
        return [
          {
            id: "task",
            name: "每天检查项目依赖是否有新的更新",
            trigger: "每天",
            status: "active",
            removed: false,
          },
        ];
      },
      async listRuns() {
        return {
          items: [
            {
              id: "run",
              scheduledAt: "今天",
              mode: "scheduled",
              status: "completed",
              attempts: [1],
            },
          ],
        };
      },
      async inspect() {
        return {
          invocationId: "run",
          taskName: "每天检查项目依赖是否有新的更新",
          cwd: "/original/workspace",
          mode: "scheduled",
          status: "completed",
          attempt: 1,
          attempts: [1],
          sessionId: "scheduled",
          canContinue: true,
        };
      },
      async readTranscript() {
        return {
          text: Array.from(
            { length: 100 },
            (_, index) => `归档对话第 ${String(index)} 行：保留原始执行结果。`,
          ).join("\n"),
        };
      },
      async continueRun() {
        forkCalls++;
        await creating;
        return fork.session;
      },
    };
    const ui = render(
      h(ScheduleBrowser, {
        port,
        width,
        height,
        onClose: () => {},
        onContinue: (session) => continued.push(session.id),
      }),
    );
    const screen = (): string => stripVTControlCharacters(ui.lastFrame() ?? "");
    try {
      await waitFor(() => assert.match(screen(), /Enter 查看/u));
      ui.stdin.write("\r");
      await waitFor(() => assert.match(screen(), /运行记录/u));
      ui.stdin.write("\r");
      await waitFor(() => {
        assert.match(screen(), /按\s+C\s+继续对话/u);
        assert.match(screen(), /从快照新建对话，使用当前工作区/u);
        assert.match(screen(), /Esc 返回/u);
        assert.ok(screen().split("\n").length <= height);
        assert.ok(
          screen()
            .split("\n")
            .every((line) => displayWidth(line) <= width),
        );
      });
      ui.stdin.write("\x1b[5~");
      await delay(30);
      assert.match(screen(), /按\s+C\s+继续对话/u);
      // Enter that opened the record must not accidentally become a second continuation action.
      ui.stdin.write("\r");
      await delay(30);
      assert.equal(forkCalls, 0);
      ui.stdin.write("C");
      await waitFor(() => assert.match(screen(), /正在创建新对话/u));
      ui.stdin.write("c");
      await delay(30);
      assert.equal(forkCalls, 1);
      finishCreating?.();
      await waitFor(() => assert.deepEqual(continued, ["fork"]));
      assert.deepEqual(fork.sent, []);
    } finally {
      finishCreating?.();
      ui.unmount();
    }
  });
}

test("Ink explains unavailable attempt state in Chinese while retaining the raw port values", async () => {
  const port: ScheduleBrowserPort = {
    async listTasks() {
      return [
        {
          id: "task",
          name: "历史检查",
          trigger: "每天",
          status: null,
          lastRunStatus: null,
          removed: true,
        },
      ];
    },
    async listRuns() {
      return {
        items: [{ id: "run", scheduledAt: "今天", mode: "manual", status: null, attempts: [1, 2] }],
      };
    },
    async inspect() {
      return {
        invocationId: "run",
        taskName: "历史检查",
        cwd: "/old",
        mode: "manual",
        status: null,
        statusUnavailableReason: "attempt_not_current",
        attempt: 1,
        attempts: [1, 2],
        sessionId: "s",
        canContinue: true,
      };
    },
    async readTranscript() {
      return { text: "历史执行记录" };
    },
    async continueRun() {
      assert.fail("viewing status must not continue the session");
    },
  };
  const ui = render(
    h(ScheduleBrowser, { port, width: 120, height: 30, onClose: () => {}, onContinue: () => {} }),
  );
  const screen = (): string => stripVTControlCharacters(ui.lastFrame() ?? "");
  try {
    await waitFor(() => {
      assert.match(screen(), /历史任务 · 历史检查/);
      assert.match(screen(), /已移除/);
      assert.match(screen(), /最近历史状态不可用/);
    });
    ui.stdin.write("\r");
    await waitFor(() => assert.match(screen(), /手动触发 · 历史状态不可用/));
    ui.stdin.write("\r");
    await waitFor(() => {
      assert.match(screen(), /触发方式：手动触发/);
      assert.match(screen(), /账本仅保留当前尝试的状态/);
      assert.match(screen(), /按\s+C\s+继续对话/);
    });
    assert.doesNotMatch(screen(), /\b(?:manual|null|attempt_not_current)\b/);
    const detail = await port.inspect("run");
    assert.equal(detail.mode, "manual");
    assert.equal(detail.status, null);
    assert.equal(detail.statusUnavailableReason, "attempt_not_current");
  } finally {
    ui.unmount();
  }
});
