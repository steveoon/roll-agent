import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSession, type SessionEvent } from "@roll-agent/runtime";
import { deadlineStatusFixture } from "../chat/ink/fixtures/deadline-status.e2e-harness.ts";
import { runRepl } from "./chat.ts";
import { createTerminalAgentStatus } from "../chat/terminal-agent-status.ts";

async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("REPL did not reach expected state");
}
function fixture(events: (() => AsyncIterable<SessionEvent>) | AgentSession) {
  const input = new PassThrough();
  const writes: string[] = [];
  const reporter = createTerminalAgentStatus({
    enabled: true,
    write: (s) => {
      writes.push(s.slice(7, -2));
    },
  });
  const session =
    events instanceof AgentSession
      ? events
      : ({
          id: "status-basic",
          send: events,
          compact: events,
          getContextWindow: () => undefined,
          getSkillSummaries: () => [],
          setUserInputAvailable() {},
          async close() {},
          approve: () => true,
          reject: () => true,
          cancelUserInput: () => true,
          resolveUserInput: () => true,
        } as unknown as AgentSession);
  const store = { countMessages: () => 1 } as unknown as Parameters<typeof runRepl>[1];
  const io = {
    input,
    output: new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }),
    terminalAgentStatus: reporter,
  };
  return { input, writes, reporter, session, store, io };
}

for (const permission of [false, true]) {
  test(`basic real AgentSession ${permission ? "permission" : "model"} timeout ends error`, async () => {
    const runtime = deadlineStatusFixture(permission);
    const f = fixture(runtime.session);
    const shutdown = new AbortController();
    let confirmSignal: AbortSignal | undefined;
    const done = runRepl(f.session, f.store, false, {
      ...f.io,
      signal: shutdown.signal,
      confirm: async (_message, signal) => {
        confirmSignal = signal;
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return true; // Even a late Yes must not authorize.
      },
    });
    try {
      f.input.write("wait without responding\n");
      if (permission) await until(() => confirmSignal !== undefined);
      await until(() => f.writes.at(-1) === "state=error:app=roll");
      assert.equal(runtime.executed(), false);
      assert.ok(!f.writes.includes("state=done:app=roll"));
      assert.equal(f.writes.filter((s) => s === "state=idle:app=roll").length, 1);
      if (permission) assert.equal(confirmSignal?.aborted, true);
    } finally {
      shutdown.abort();
      await done;
      f.input.end();
      await runtime.close();
    }
  });
}

test("basic REPL permission rejection resumes working, preserves done and accepts next input", async () => {
  const confirm = Promise.withResolvers<boolean>();
  const tail = Promise.withResolvers<void>();
  const f = fixture(async function* () {
    yield {
      type: "confirmation-required",
      approvalId: "test",
      agentName: "fixture",
      toolName: "test",
      input: {},
    };
    yield { type: "message-finish", text: "continued" };
    await tail.promise;
  });
  const done = runRepl(f.session, f.store, false, { ...f.io, confirm: () => confirm.promise });
  try {
    f.input.write("hello\n");
    await until(() => f.writes.at(-1) === "state=blocked:kind=permission:app=roll");
    confirm.resolve(false);
    await until(() => f.writes.at(-1) === "state=working:app=roll");
    tail.resolve();
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    f.input.write("second\n");
    await until(() => f.writes.filter((s) => s === "state=done:app=roll").length === 2);
    assert.equal(f.writes.filter((s) => s === "state=idle:app=roll").length, 1);
  } finally {
    confirm.resolve(false);
    tail.resolve();
    f.input.write("exit\n");
    await done;
    f.input.end();
    f.reporter.dispose();
  }
  assert.equal(f.writes.at(-1), "state=clear");
});

test("basic REPL waits for iterator tail and reports failure rather than premature done", async () => {
  const tail = Promise.withResolvers<void>();
  const f = fixture(async function* () {
    yield { type: "message-finish", text: "answer" };
    await tail.promise;
    throw new Error("persistence failure");
  });
  const done = runRepl(f.session, f.store, false, f.io);
  f.input.write("hello\n");
  await until(() => f.writes.at(-1) === "state=working:app=roll");
  assert.ok(!f.writes.includes("state=done:app=roll"));
  tail.resolve();
  await until(() => f.writes.at(-1) === "state=error:app=roll");
  f.input.write("exit\n");
  await done;
  f.input.end();
  assert.equal(f.writes.at(-1), "state=error:app=roll");
  f.reporter.dispose();
});

test("basic REPL manual compact succeeds without message-finish; terminal cancellation waits for cleanup", async () => {
  const tail = Promise.withResolvers<void>();
  const f = fixture(async function* () {
    yield { type: "compaction-start", reason: "manual" };
  });
  const done = runRepl(f.session, f.store, false, f.io);
  f.input.write("/compact\n");
  await until(() => f.writes.at(-1) === "state=done:app=roll");
  f.session.send = async function* () {
    yield { type: "turn-cancelled", reason: "user", message: "cancelled" };
    await tail.promise;
  };
  f.input.write("cancel\n");
  await until(() => f.writes.at(-1) === "state=working:app=roll");
  tail.resolve();
  await until(() => f.writes.at(-1) === "state=idle:app=roll");
  f.input.write("exit\n");
  await done;
  f.input.end();
  f.reporter.dispose();
});

test("basic REPL preparation errors are failed, confirmed abort is cancelled", async () => {
  for (const cancel of [false, true]) {
    const gate = Promise.withResolvers<void>();
    const controller = new AbortController();
    const f = fixture(async function* () {});
    const done = runRepl(f.session, f.store, false, {
      ...f.io,
      signal: controller.signal,
      beforeSend: async () => {
        await gate.promise;
      },
    });
    f.input.write("prepare\n");
    await until(() => f.writes.at(-1) === "state=working:app=roll");
    if (cancel) controller.abort();
    gate.reject(new Error("preparation stopped"));
    await until(() => f.writes.at(-1) === `state=${cancel ? "idle" : "error"}:app=roll`);
    f.input.write("exit\n");
    await done;
    f.input.end();
    f.reporter.dispose();
  }
});

test("basic REPL question timeout resumes, expired requests never report blocked", async () => {
  type Required = Extract<SessionEvent, { type: "user-input-required" }>;
  for (const expired of [false, true]) {
    const f = fixture(async function* () {
      yield {
        type: "user-input-required",
        requestId: "b92f0f10-a5f5-4fad-a243-53d39c9972bf" as Required["requestId"],
        expiresAt: new Date(Date.now() + (expired ? -1 : 50)).toISOString(),
        form: { title: "Fixture", description: "Question", controls: [] },
      };
    });
    const done = runRepl(f.session, f.store, false, {
      ...f.io,
      userInputPrompt: {
        request: async (_form, signal) => {
          if (!signal?.aborted) {
            await new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          return { status: "cancelled", reason: "timeout" };
        },
      },
    });
    f.input.write("question\n");
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    assert.equal(f.writes.includes("state=blocked:kind=question:app=roll"), !expired);
    f.input.write("exit\n");
    await done;
    f.input.end();
    f.reporter.dispose();
  }
});

test("basic expired/invalid permissions never block; expiry alone can finish done", async () => {
  for (const expiry of ["past", "invalid", "future"] as const) {
    const f = fixture(async function* () {
      yield {
        type: "confirmation-required",
        approvalId: "deadline",
        agentName: "fixture",
        toolName: "test",
        input: {},
        expiresAt:
          expiry === "invalid"
            ? "invalid"
            : new Date(Date.now() + (expiry === "past" ? -10 : 40)).toISOString(),
      };
    });
    const decisions: string[] = [];
    f.session.approve = () => {
      decisions.push("approved");
      return true;
    };
    f.session.reject = (_id, reason) => {
      decisions.push(reason ?? "rejected");
      return true;
    };
    let prompts = 0;
    const done = runRepl(f.session, f.store, false, {
      ...f.io,
      confirm: async (_message, signal) => {
        prompts++;
        if (!signal?.aborted) {
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return true;
      },
    });
    f.input.write("deadline\n");
    try {
      await until(() => f.writes.at(-1) === "state=done:app=roll");
      assert.equal(prompts, expiry === "future" ? 1 : 0);
      assert.equal(
        f.writes.includes("state=blocked:kind=permission:app=roll"),
        expiry === "future",
      );
      assert.deepEqual(decisions, [
        expiry === "invalid" ? "审批请求截止时间无效" : "审批请求已超时",
      ]);
    } finally {
      f.input.write("exit\n");
      await done;
      f.input.end();
    }
  }
});

test("basic runtime cancellation is error rather than idle", async () => {
  const f = fixture(async function* () {
    yield { type: "turn-cancelled", reason: "runtime", message: "runtime stopped" };
  });
  const done = runRepl(f.session, f.store, false, f.io);
  f.input.write("runtime stop\n");
  try {
    await until(() => f.writes.at(-1) === "state=error:app=roll");
    assert.equal(f.writes.filter((s) => s === "state=idle:app=roll").length, 1);
  } finally {
    f.input.write("exit\n");
    await done;
    f.input.end();
  }
});

test("basic session switch resets only after successful adoption; REPL leaves clear to owner", async () => {
  const f = fixture(async function* () {});
  const next = { ...f.session, id: "next-status" } as unknown as AgentSession;
  const retired: string[] = [];
  const close = mock.method(f.session, "close", async () => {
    retired.push(f.session.id);
  });
  let attempts = 0;
  const done = runRepl(
    f.session,
    {
      ...f.store,
      listThreads: () => [{ id: next.id, title: "Next", updatedAt: new Date().toISOString() }],
      getThread: () => ({ title: "Next" }),
    } as unknown as Parameters<typeof runRepl>[1],
    false,
    {
      ...f.io,
      sessionPicker: async () => ({ threadId: next.id }),
      resumeSession: async () => {
        if (++attempts === 1) throw new Error("fixture resume failure");
        return next;
      },
    },
  );
  try {
    f.reporter.beginTurn().finish("failed");
    f.input.write("/resume\n");
    await until(() => attempts === 1);
    await delay(10);
    assert.equal(f.writes.at(-1), "state=error:app=roll");
    f.input.write("/resume\n");
    await until(() => f.writes.at(-1) === "state=idle:app=roll");
    assert.deepEqual(retired, [f.session.id]);
    f.input.write("exit\n");
    await done;
    assert.ok(!f.writes.includes("state=clear"));
    f.reporter.dispose();
  } finally {
    close.mock.restore();
    f.input.end();
  }
});
