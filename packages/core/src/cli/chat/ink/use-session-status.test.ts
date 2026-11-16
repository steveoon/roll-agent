import assert from "node:assert/strict";
import { test, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render, cleanup } from "ink-testing-library";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession, type SessionEvent } from "@roll-agent/runtime";
import { createTerminalAgentStatus } from "../terminal-agent-status.ts";
import { useSession } from "./use-session.ts";
import { deadlineStatusFixture } from "./fixtures/deadline-status.e2e-harness.ts";

afterEach(() => {
  cleanup();
  mock.restoreAll();
});
const fields = (s: string) => s.slice("\u001B]7501;".length, -2);
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("status transition did not arrive");
}
function harness(
  events: (() => AsyncIterable<SessionEvent>) | AgentSession,
  beforeSend?: (signal: AbortSignal) => Promise<void>,
) {
  const writes: string[] = [];
  const reporter = createTerminalAgentStatus({
    enabled: true,
    write: (s) => {
      writes.push(fields(s));
    },
  });
  const session =
    events instanceof AgentSession
      ? events
      : new AgentSession({
          id: "status-fixture",
          model: new MockLanguageModelV4(),
          sources: [],
          maxSteps: 2,
        });
  if (typeof events === "function") {
    mock.method(session, "send", events);
    mock.method(session, "compact", events);
  }
  let current: ReturnType<typeof useSession> | undefined;
  function Harness() {
    current = useSession(session, {
      model: "fixture",
      contextWindow: undefined,
      terminalAgentStatus: reporter,
      ...(beforeSend ? { beforeSend } : {}),
    });
    return null;
  }
  const view = render(h(Harness));
  assert.ok(current);
  return {
    writes,
    reporter,
    session,
    view,
    get hook() {
      assert.ok(current);
      return current;
    },
  };
}

for (const permission of [false, true]) {
  test(`Ink real AgentSession ${permission ? "permission" : "model"} timeout ends error`, async () => {
    const runtime = deadlineStatusFixture(permission);
    const f = harness(runtime.session);
    try {
      f.hook.submit("wait without responding");
      if (permission) await until(() => f.hook.state.phase === "confirm");
      await until(() => f.writes.at(-1) === "state=error:app=roll");
      await until(() => f.hook.state.phase === "idle");
      assert.equal(runtime.executed(), false);
      assert.ok(!f.writes.includes("state=done:app=roll"));
      assert.ok(!f.writes.includes("state=idle:app=roll"));
      assert.equal(f.writes.includes("state=blocked:kind=permission:app=roll"), permission);
    } finally {
      f.view.unmount();
      await runtime.close();
    }
  });
}

test("Ink completion waits for iterator tail; late persistence failure is error, not done", async () => {
  const tail = Promise.withResolvers<void>();
  const f = harness(async function* () {
    yield { type: "message-finish", text: "answer" };
    await tail.promise;
    throw new Error("persist failed");
  });
  try {
    f.hook.submit("hello");
    await delay(20);
    assert.deepEqual(f.writes, ["state=working:app=roll"]);
    tail.resolve();
    await until(() => f.writes.at(-1) === "state=error:app=roll");
    assert.equal(f.hook.state.phase, "idle");
    f.reporter.ready();
    assert.equal(f.writes.at(-1), "state=error:app=roll");
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

test("Ink actual permission wait, rejection and continuation; auto approve never blocks", async () => {
  const f = harness(async function* () {
    yield {
      type: "confirmation-required",
      approvalId: "test",
      agentName: "fixture",
      toolName: "test",
      input: {},
    };
    yield { type: "message-finish", text: "continued" };
  });
  mock.method(f.session, "reject", () => {});
  mock.method(f.session, "approve", () => {});
  try {
    f.hook.submit("hello");
    await until(() => f.writes.at(-1) === "state=blocked:kind=permission:app=roll");
    f.hook.resolveConfirm({ approved: false });
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    assert.deepEqual(f.writes, [
      "state=working:app=roll",
      "state=blocked:kind=permission:app=roll",
      "state=working:app=roll",
      "state=done:app=roll",
    ]);
    f.writes.length = 0;
    f.hook.setAutoMode(true);
    f.hook.submit("auto");
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    assert.deepEqual(f.writes, ["state=working:app=roll", "state=done:app=roll"]);
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

test("Ink question submission, expired forms and timeout continuation", async () => {
  type Required = Extract<SessionEvent, { type: "user-input-required" }>;
  const requestId = "b92f0f10-a5f5-4fad-a243-53d39c9972bf" as Required["requestId"];
  let expires = Date.now() + 60_000;
  const f = harness(async function* () {
    yield {
      type: "user-input-required",
      requestId,
      expiresAt: new Date(expires).toISOString(),
      form: { title: "Fixture", description: "Question", controls: [] },
    };
  });
  mock.method(f.session, "resolveUserInput", () => true);
  mock.method(f.session, "cancelUserInput", () => true);
  try {
    f.hook.submit("question");
    await until(() => f.writes.at(-1) === "state=blocked:kind=question:app=roll");
    f.hook.resolveUserInput(requestId, { status: "cancelled", reason: "cancelled" });
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    f.writes.length = 0;
    expires = Date.now() - 10;
    f.hook.submit("expired");
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    assert.ok(!f.writes.some((s) => s.includes("blocked")));
    f.writes.length = 0;
    expires = Date.now() + 40;
    f.hook.submit("timeout");
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    assert.ok(f.writes.includes("state=blocked:kind=question:app=roll"));
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

test("Ink cancellation remains working until iterator cleanup; compact completes without message-finish", async () => {
  const tail = Promise.withResolvers<void>();
  const f = harness(async function* () {
    yield { type: "turn-cancelled", reason: "user", message: "cancelled" };
    await tail.promise;
  });
  mock.method(f.session, "cancel", () => true);
  try {
    f.hook.submit("cancel");
    f.hook.cancel();
    await delay(15);
    assert.equal(f.writes.at(-1), "state=working:app=roll");
    tail.resolve();
    await until(() => f.writes.at(-1) === "state=idle:app=roll");
    mock.method(f.session, "compact", async function* () {
      yield { type: "compaction-start", reason: "manual" };
    });
    f.hook.compact();
    await until(() => f.writes.at(-1) === "state=done:app=roll");
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

test("Ink preparation failure differs from confirmed preparation abort", async () => {
  for (const cancel of [false, true]) {
    const gate = Promise.withResolvers<void>();
    const f = harness(
      async function* () {},
      async (signal) => {
        if (cancel) {
          signal.addEventListener("abort", () => gate.reject(signal.reason), { once: true });
        }
        await gate.promise;
      },
    );
    try {
      f.hook.submit("prepare");
      assert.equal(f.writes.at(-1), "state=working:app=roll");
      if (cancel) f.hook.cancel();
      else gate.reject(new Error("auth failed"));
      await until(() => f.writes.at(-1) === `state=${cancel ? "idle" : "error"}:app=roll`);
    } finally {
      f.view.unmount();
      await f.session.close();
    }
  }
});

test("Ink runtime cancellation is error, including an iterator without a thrown exception", async () => {
  const f = harness(async function* () {
    yield { type: "turn-cancelled", reason: "runtime", message: "runtime stopped" };
  });
  try {
    f.hook.submit("runtime stop");
    await until(() => f.writes.at(-1) === "state=error:app=roll");
    assert.ok(!f.writes.includes("state=idle:app=roll"));
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

for (const auto of [false, true]) {
  test(`Ink rejects expired/invalid permission before rendering or auto approval (auto=${auto})`, async () => {
    for (const expiresAt of [new Date(Date.now() - 1000).toISOString(), "invalid"]) {
      const f = harness(async function* () {
        yield {
          type: "confirmation-required",
          approvalId: "expired",
          agentName: "fixture",
          toolName: "test",
          input: {},
          expiresAt,
        };
      });
      const approve = mock.method(f.session, "approve", () => {});
      const reject = mock.method(f.session, "reject", () => {});
      try {
        f.hook.setAutoMode(auto);
        f.hook.submit("expired");
        await until(() => f.writes.at(-1) === "state=done:app=roll");
        assert.equal(f.hook.state.pendingConfirm, undefined);
        assert.ok(!f.writes.some((s) => s.includes("blocked")));
        assert.equal(approve.mock.callCount(), 0);
        assert.equal(reject.mock.callCount(), 1);
        assert.equal(
          reject.mock.calls[0]?.arguments[1],
          expiresAt === "invalid" ? "审批请求截止时间无效" : "审批请求已超时",
        );
      } finally {
        f.view.unmount();
        await f.session.close();
      }
    }
  });
}

test("Ink expired permission alone can continue to success; late clicks settle only once", async () => {
  const deadline = Date.now() + 60_000;
  const f = harness(async function* () {
    yield {
      type: "confirmation-required",
      approvalId: "race",
      agentName: "fixture",
      toolName: "test",
      input: {},
      expiresAt: new Date(deadline).toISOString(),
    };
  });
  const approve = mock.method(f.session, "approve", () => {});
  const reject = mock.method(f.session, "reject", () => {});
  try {
    f.hook.submit("boundary");
    await until(() => f.hook.state.phase === "confirm");
    const clock = mock.method(Date, "now", () => deadline);
    f.hook.resolveConfirm({ approved: true });
    f.hook.resolveConfirm({ approved: true });
    clock.mock.restore();
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    assert.equal(approve.mock.callCount(), 0);
    assert.equal(reject.mock.callCount(), 1);
    assert.equal(reject.mock.calls[0]?.arguments[1], "审批请求已超时");
    assert.deepEqual(f.writes, [
      "state=working:app=roll",
      "state=blocked:kind=permission:app=roll",
      "state=working:app=roll",
      "state=done:app=roll",
    ]);
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

test("Ink real user cancellation during permission settles the same wait and clears its timer", async () => {
  const runtime = deadlineStatusFixture(true, 60_000);
  const f = harness(runtime.session);
  try {
    f.hook.submit("cancel permission");
    await until(() => f.hook.state.phase === "confirm");
    f.hook.cancel();
    await until(() => f.writes.at(-1) === "state=idle:app=roll");
    await until(() => f.hook.state.phase === "idle");
    f.hook.resolveConfirm({ approved: true });
    assert.equal(runtime.executed(), false);
    assert.ok(!f.writes.includes("state=done:app=roll"));
  } finally {
    f.view.unmount();
    await runtime.close();
  }
});

test("Ink permission expiry alone releases a hidden prompt and can still complete successfully", async () => {
  const f = harness(async function* () {
    yield {
      type: "confirmation-required",
      approvalId: "timer",
      agentName: "fixture",
      toolName: "test",
      input: {},
      expiresAt: new Date(Date.now() + 40).toISOString(),
    };
  });
  const reject = mock.method(f.session, "reject", () => {});
  try {
    f.hook.submit("no UI response");
    await until(() => f.writes.at(-1) === "state=done:app=roll");
    await until(() => f.hook.state.phase === "idle");
    assert.equal(reject.mock.callCount(), 1);
    assert.equal(reject.mock.calls[0]?.arguments[1], "审批请求已超时");
    assert.ok(f.writes.includes("state=blocked:kind=permission:app=roll"));
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

test("Ink approval timer is cleared on decision and unmount, never settles the next approval", async () => {
  const f = harness(async function* () {
    for (const [id, ms] of [
      ["first", 200],
      ["second", 3_000_000_000],
    ] as const) {
      yield {
        type: "confirmation-required",
        approvalId: id,
        agentName: "fixture",
        toolName: "test",
        input: {},
        expiresAt: new Date(Date.now() + ms).toISOString(),
      };
    }
  });
  const approve = mock.method(f.session, "approve", () => {});
  const reject = mock.method(f.session, "reject", () => {});
  try {
    f.hook.submit("two approvals");
    await until(() => f.hook.state.phase === "confirm");
    f.hook.resolveConfirm({ approved: true });
    await until(
      () => approve.mock.callCount() === 1 && f.hook.state.pendingConfirm?.approvalId === "second",
    );
    await delay(220); // First timer must be cleared; >2^31 second deadline must not overflow.
    assert.equal(reject.mock.callCount(), 0);
    assert.equal(f.writes.at(-1), "state=blocked:kind=permission:app=roll");
    f.reporter.resetSession();
    f.view.unmount();
    await until(() => reject.mock.callCount() === 1);
    assert.equal(f.writes.at(-1), "state=idle:app=roll");
    f.hook.resolveConfirm({ approved: true });
    assert.equal(approve.mock.callCount(), 1);
  } finally {
    f.view.unmount();
    await f.session.close();
  }
});

test("Ink old tail and unmount do not clear new session or revive disposed owner", async () => {
  const tail = Promise.withResolvers<void>();
  const f = harness(async function* () {
    await tail.promise;
  });
  try {
    f.hook.submit("old");
    f.reporter.resetSession();
    tail.resolve();
    await delay(15);
    assert.equal(f.writes.at(-1), "state=idle:app=roll");
    f.view.unmount();
    assert.ok(!f.writes.includes("state=clear"));
    f.reporter.dispose();
    await delay(15);
    assert.equal(f.writes.at(-1), "state=clear");
  } finally {
    await f.session.close();
  }
});
