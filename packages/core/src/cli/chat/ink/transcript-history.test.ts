import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "@roll-agent/runtime";
import type { ModelMessage } from "ai";
import { createTranscriptHistorySource } from "./transcript-history.ts";

test("display history survives repeated active-context replacement and SQLite reopen without replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-display-history-"));
  let store = new ThreadStore(dir);
  try {
    const id = store.createThread();
    for (let round = 0; round < 3; round++) {
      store.appendMessages(
        id,
        Array.from(
          { length: 60 },
          (_, index): ModelMessage => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `round-${round}-message-${index}`,
          }),
        ),
      );
      store.replaceMessages(id, store.getMessages(id).slice(-2));
    }
    store.close();
    store = new ThreadStore(dir);
    const active = store.getMessages(id);
    const reader = createTranscriptHistorySource(store)(id);
    let page = reader.read();
    assert.equal(page.items.length, 50);
    let items = [...page.items];
    let pages = 1;
    while (page.nextBeforeSequence !== undefined) {
      page = reader.read(page.nextBeforeSequence);
      assert.ok(page.items.length <= 50);
      items = [...page.items, ...items];
      pages++;
    }
    assert.equal(pages, 4);
    assert.equal(items.length, 180);
    assert.equal(new Set(items.map((item) => item.id)).size, 180);
    assert.deepEqual(items[0], {
      kind: "user",
      id: `transcript:${id}:0`,
      text: "round-0-message-0",
    });
    assert.deepEqual(store.getMessages(id), active);
    assert.equal(active.length, 2);
    assert.equal(store.listToolExecutions(id).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("older pages retain failed tool outcomes across the page boundary and exclude new turns", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-display-pages-"));
  const store = new ThreadStore(dir);
  try {
    const id = store.createThread();
    const messages: ModelMessage[] = Array.from({ length: 100 }, (_, index) => ({
      role: "user",
      content: `old-${index}`,
    }));
    messages[49] = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "failed",
          toolName: "roll__bash",
          input: { command: "false" },
        },
      ],
    };
    messages[50] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "failed",
          toolName: "roll__bash",
          output: { type: "error-text", value: "failed" },
        },
      ],
    };
    store.appendMessages(id, messages);
    const source = createTranscriptHistorySource(store);
    const reader = source(id);
    const recent = reader.read();
    store.appendMessages(id, [{ role: "user", content: "live turn" }]);
    const older = reader.read(recent.nextBeforeSequence);
    assert.equal(older.items.find((item) => item.kind === "tool")?.ok, false);
    assert.ok(!JSON.stringify([...recent.items, ...older.items]).includes("live turn"));
    assert.ok(JSON.stringify(source(id).read().items).includes("live turn"));
    assert.deepEqual(reader.read().items, recent.items);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive display hides internal recovery markers without hiding user lookalikes", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-display-markers-"));
  const store = new ThreadStore(dir);
  try {
    const id = store.createThread();
    const marker: ModelMessage = {
      role: "assistant",
      content: "Roll interrupted-turn recovery checkpoint",
      providerOptions: {
        rollHarness: {
          cancelledTurnRecovery: {
            version: 1,
            kind: "cancelled-turn-recovery",
            toolCallId: "roll-recovery-test",
            modelContext: "internal",
          },
        },
      },
    };
    store.appendMessages(id, [
      { role: "user", content: "Roll interrupted-turn recovery checkpoint" },
      marker,
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "unknown", toolName: "roll__bash", input: {} }],
      },
    ]);
    const page = createTranscriptHistorySource(store)(id).read();
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.kind, "user");
    assert.equal(page.items[1]?.kind, "tool");
    if (page.items[1]?.kind === "tool") assert.equal(page.items[1].ok, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retrying the first history page keeps the original snapshot boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-display-retry-"));
  const store = new ThreadStore(dir);
  try {
    const id = store.createThread();
    store.appendMessages(id, [{ role: "user", content: "old prompt" }]);
    let fail = true;
    const reader = createTranscriptHistorySource({
      getTranscriptCompleteness: store.getTranscriptCompleteness.bind(store),
      listToolExecutions: store.listToolExecutions.bind(store),
      listRecentTranscriptMessages: (threadId, options) => {
        if (options?.limit !== 1 && fail) {
          fail = false;
          throw new Error("temporary page failure");
        }
        return store.listRecentTranscriptMessages(threadId, options);
      },
    })(id);
    assert.throws(() => reader.read(), /temporary page failure/);
    store.appendMessages(id, [{ role: "user", content: "new live prompt" }]);
    const page = reader.read();
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0], { kind: "user", id: `transcript:${id}:0`, text: "old prompt" });
    assert.equal(page.nextBeforeSequence, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
