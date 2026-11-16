import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTerminalAgentStatus,
  terminalAgentStatusEnabled,
  terminalAgentOutcomeAfterEvent,
} from "./terminal-agent-status.ts";

test("only user cancellation is idle; abnormal cancellations and prior failures stay error", () => {
  for (const [reason, expected] of [
    ["user", "cancelled"],
    ["timeout", "failed"],
    ["runtime", "failed"],
  ] as const) {
    const event = { type: "turn-cancelled", reason, message: reason } as const;
    assert.equal(terminalAgentOutcomeAfterEvent("completed", event), expected);
    assert.equal(terminalAgentOutcomeAfterEvent("failed", event), "failed");
  }
});

const osc = (fields: string) => `\u001B]7501;${fields}\u001B\\`;
function fixture(enabled = true) {
  const writes: string[] = [];
  const reporter = createTerminalAgentStatus({
    enabled,
    write: (s) => {
      writes.push(s);
    },
  });
  return { writes, reporter };
}

test("completion survives ready calls; finished turns and disposal are inert", () => {
  const { reporter, writes } = fixture();
  reporter.ready();
  const turn = reporter.beginTurn();
  turn.wait("permission");
  turn.resume();
  turn.finish("completed");
  reporter.ready();
  turn.resume();
  reporter.dispose();
  reporter.dispose();
  reporter.beginTurn().finish("failed");
  assert.deepEqual(
    writes,
    [
      "state=idle:app=roll",
      "state=working:app=roll",
      "state=blocked:kind=permission:app=roll",
      "state=working:app=roll",
      "state=done:app=roll",
      "state=clear",
    ].map(osc),
  );
});

test("deduplication includes wait kind; reset and new turns invalidate old handles", () => {
  const { reporter, writes } = fixture();
  const old = reporter.beginTurn();
  old.resume();
  old.wait("permission");
  old.wait("permission");
  old.wait("question");
  reporter.resetSession();
  old.finish("failed");
  old.resume();
  const next = reporter.beginTurn();
  const last = reporter.beginTurn();
  next.finish("failed");
  last.finish("cancelled");
  last.finish("failed");
  assert.deepEqual(
    writes,
    [
      "state=working:app=roll",
      "state=blocked:kind=permission:app=roll",
      "state=blocked:kind=question:app=roll",
      "state=idle:app=roll",
      "state=working:app=roll",
      "state=idle:app=roll",
    ].map(osc),
  );
});

test("failed outcome stays error until a real transition", () => {
  const { reporter, writes } = fixture();
  reporter.beginTurn().finish("failed");
  reporter.ready();
  assert.equal(writes.at(-1), osc("state=error:app=roll"));
});

test("disabled and broken writers cannot affect the chat", () => {
  const { reporter, writes } = fixture(false);
  reporter.ready();
  reporter.beginTurn().wait("question");
  reporter.resetSession();
  reporter.dispose();
  assert.deepEqual(writes, []);
  let attempts = 0;
  const broken = createTerminalAgentStatus({
    enabled: true,
    write: () => {
      attempts++;
      throw new Error("EIO");
    },
  });
  assert.doesNotThrow(() => {
    broken.ready();
    broken.beginTurn().finish("failed");
    broken.dispose();
  });
  assert.equal(attempts, 1);
});

test("only Herdr interactive chat with all three TTY streams enables reporting", () => {
  const yes = {
    terminalId: "t1",
    interactive: true,
    stdinTty: true,
    stdoutTty: true,
    stderrTty: true,
  };
  assert.equal(terminalAgentStatusEnabled(yes), true);
  for (const key of ["interactive", "stdinTty", "stdoutTty", "stderrTty"] as const) {
    assert.equal(terminalAgentStatusEnabled({ ...yes, [key]: false }), false);
  }
  assert.equal(terminalAgentStatusEnabled({ ...yes, terminalId: undefined }), false);
  assert.equal(terminalAgentStatusEnabled({ ...yes, terminalId: " " }), false);
});
