import { test } from "node:test";
import assert from "node:assert/strict";
import { appendInputHistory, INPUT_HISTORY_LIMIT } from "./input-history.ts";

test("input history retains the newest 50 normalized entries", () => {
  let history: readonly string[] = [];
  for (let index = 0; index < INPUT_HISTORY_LIMIT + 5; index += 1) {
    history = appendInputHistory(history, ` prompt-${index} `);
  }

  assert.equal(history.length, INPUT_HISTORY_LIMIT);
  assert.equal(history[0], "prompt-5");
  assert.equal(history.at(-1), `prompt-${INPUT_HISTORY_LIMIT + 4}`);
});

test("input history moves a repeated entry to newest and ignores empty input", () => {
  const initial = ["first", "second", "third"];
  const repeated = appendInputHistory(initial, " second ");

  assert.deepEqual(repeated, ["first", "third", "second"]);
  assert.strictEqual(appendInputHistory(repeated, "  \n "), repeated);
});
