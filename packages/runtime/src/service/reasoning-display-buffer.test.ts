import assert from "node:assert/strict";
import test from "node:test";
import { TurnReasoningDisplay } from "./turn-reasoning-display.ts";
import { ReasoningDisplayBuffer } from "./reasoning-display-buffer.ts";

test("display streams complete words and redacts credentials split anywhere across chunks", () => {
  const block = new ReasoningDisplayBuffer();
  const values = ["Checking ", "the files。", "Bea", "rer ", "fixture", "-only ", "done"];
  const shown = values.map((part) => block.append(part));
  assert.equal(shown[0], "Checking ");
  assert.equal(shown[1], "the files。");
  assert.equal(shown.join("") + block.finish(), "Checking the files。Bearer [redacted] done");
});

test("truncation never flushes the unfinished credential at the display limit", () => {
  const block = new ReasoningDisplayBuffer();
  assert.equal(block.append("Done。"), "Done。");
  assert.equal(block.append("x".repeat(20_000)), "\n…（后续内容已省略）");
  assert.equal(block.append(" tail"), "");
  assert.equal(block.finish(), "");
});

test("one omission marker closes a block if later redaction would revise its sent prefix", () => {
  const block = new ReasoningDisplayBuffer();
  // The partial header looks like a Bearer value until the PEM header is complete.
  assert.match(block.append("prefix -----BEGIN BEARER RSA "), /^prefix /u);
  assert.equal(block.append("PRIVATE KEY-----\nprivate-fixture\n"), "\n…（后续内容已省略）");
  assert.equal(block.append("-----END PRIVATE KEY----- end"), "");
  assert.equal(block.finish(), "");
});

test("a partially emitted credential marker never suppresses the following explanation", () => {
  for (const [parts, expected] of [
    [["Checking ", "bearer ", "fixture ", "done."], "Checking Bearer [redacted] done."],
    [
      [
        "Checking ",
        "-----BEGIN RSA ",
        "PRIVATE KEY-----\nfixture\n",
        "-----END RSA PRIVATE KEY-----\nDone.",
      ],
      "Checking [redacted]\nDone.",
    ],
  ] as const) {
    const buffer = new ReasoningDisplayBuffer();
    assert.equal(parts.map((part) => buffer.append(part)).join("") + buffer.finish(), expected);
  }
});

test("a retry reusing the native block ID cannot join an earlier partial summary", () => {
  const events: Array<{ id: string; text: string }> = [];
  const display = new TurnReasoningDisplay(
    (event) => event.delta,
    (id, text) => events.push({ id, text }),
  );
  const append = (value: string) =>
    display.append({ type: "reasoning-delta", reasoningId: "0", delta: value });
  append("Attempt one. ");
  append("unfinished");
  display.reset();
  append("Attempt two.");
  display.end("0");
  const ids = [...new Set(events.map((event) => event.id))];
  assert.deepEqual(
    ids.map((id) =>
      events
        .filter((event) => event.id === id)
        .map((event) => event.text)
        .join(""),
    ),
    ["Attempt one. ", "Attempt two."],
  );
});
