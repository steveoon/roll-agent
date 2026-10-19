import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ToolInputActivityTracker } from "./tool-input-activity.ts";
import type { SessionEvent } from "../types/events.ts";

type Activity = Extract<SessionEvent, { type: "tool-input-activity" }>;
function fixture() {
  const events: Activity[] = [];
  const tracker = new ToolInputActivityTracker(
    (name) => (name === "roll__write_file" ? "roll.write_file" : undefined),
    (event) => events.push(event),
    10,
  );
  return { tracker, events };
}

test("tool input activity coalesces deltas/membership, ends calls independently and clears timers", async () => {
  const { tracker, events } = fixture();
  tracker.start("a", "roll__write_file");
  assert.equal(events.length, 1);
  tracker.start("b", "roll__write_file");
  for (let i = 0; i < 1000; i += 1) {
    tracker.delta("a");
    tracker.delta("b");
  }
  assert.equal(events.length, 1, "delta count is not a UI or logging flood");
  await delay(25);
  assert.deepEqual(
    events.at(-1)?.calls.map((call) => call.toolCallId),
    ["a", "b"],
  );
  tracker.end("a");
  assert.deepEqual(
    events.at(-1)?.calls.map((call) => call.toolCallId),
    ["b"],
  );
  tracker.start("c", "roll__write_file");
  tracker.clear();
  assert.deepEqual(events.at(-1)?.calls, []);
  const count = events.length;
  await delay(25);
  assert.equal(events.length, count, "late timer must not resurrect cleared state");
  tracker.dispose();
});

test("unknown ids/names, unsafe registered display names and duplicate starts do not leak text", () => {
  const { tracker, events } = fixture();
  tracker.delta("orphan");
  tracker.end("orphan");
  assert.equal(events.length, 0);
  tracker.start("x", "SECRET\u001b[31m");
  assert.deepEqual(events.at(-1)?.calls, [{ toolCallId: "x" }]);
  tracker.start("x", "roll__write_file");
  assert.equal(events.length, 1, "duplicate start does not replace identity/name");
  assert.doesNotMatch(JSON.stringify(events), /SECRET|inputText|delta|tokens/);
  tracker.dispose();
  const unsafe: Activity[] = [];
  const other = new ToolInputActivityTracker(
    () => "roll.\nSECRET",
    (event) => unsafe.push(event),
  );
  other.start("a", "ignored");
  assert.deepEqual(unsafe[0]?.calls, [{ toolCallId: "a" }]);
  other.dispose();
});
