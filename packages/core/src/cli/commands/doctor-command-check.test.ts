import test from "node:test";
import assert from "node:assert/strict";
import { formatScheduledCommandCheck } from "./doctor.ts";

test("warns when an agent command is unreachable in the scheduled-service environment", () => {
  const result = formatScheduledCommandCheck({
    items: [
      { agentName: "notify-agent", command: "node", reachable: true },
      { agentName: "py-agent", command: "python3", reachable: false },
    ],
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /py-agent/);
  assert.match(result.message, /python3/);
  assert.doesNotMatch(result.message, /notify-agent/);
  assert.match(result.fix ?? "", /scheduler[\s\S]*env|env[\s\S]*PATH/u);
});

test("ok when every agent command is reachable", () => {
  const result = formatScheduledCommandCheck({
    items: [{ agentName: "notify-agent", command: "node", reachable: true }],
  });
  assert.equal(result.status, "ok");
});

test("ok with explanatory message when no stdio agents are registered", () => {
  const result = formatScheduledCommandCheck({ items: [] });
  assert.equal(result.status, "ok");
  assert.match(result.message, /无|没有/u);
});
