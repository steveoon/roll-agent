import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThreadStore } from "./thread-store.ts";

function temporaryStore() {
  const dir = mkdtempSync(join(tmpdir(), "roll-turn-input-"));
  return { dir, store: new ThreadStore(dir) };
}

const message = { role: "user", content: "same explicit input" } as const;

test("accepted input receipt is atomic, scoped and idempotent across reopen and replacement", () => {
  const { dir, store } = temporaryStore();
  let closed = false;
  try {
    const thread = store.createThread();
    const first = store.acceptTurnInput(thread, "A", message);
    assert.equal(first.transcriptSequence, 0);
    assert.deepEqual(store.acceptTurnInput(thread, "A", message), first);
    store.acceptTurnInput(thread, "B", message);
    assert.equal(store.listTranscriptMessages(thread).length, 2);
    assert.throws(
      () => store.acceptTurnInput(thread, "A", { ...message, content: "different" }),
      /input.*conflict/i,
    );
    store.replaceMessages(thread, []);
    store.close();
    closed = true;
    const reopened = new ThreadStore(dir);
    try {
      assert.deepEqual(reopened.acceptTurnInput(thread, "A", message), first);
      assert.deepEqual(
        reopened.getMessages(thread),
        [],
        "receipt retry must not reinsert compacted input",
      );
      assert.equal(reopened.listTranscriptMessages(thread).length, 2);
      const other = reopened.createThread();
      reopened.acceptTurnInput(other, "A", message);
      assert.equal(reopened.getTurnInput(other, "A")?.transcriptSequence, 0);
      reopened.deleteThread(thread);
      assert.equal(reopened.getTurnInput(thread, "A"), undefined);
      assert.ok(reopened.getTurnInput(other, "A"));
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt insert failure rolls back both active and archived message insertion", () => {
  const { dir, store } = temporaryStore();
  const db = new DatabaseSync(join(dir, "threads.db"));
  try {
    const thread = store.createThread();
    db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON thread_turn_inputs BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END;",
    );
    assert.throws(() => store.acceptTurnInput(thread, "A", message), /receipt rejected/);
    assert.deepEqual(store.getMessages(thread), []);
    assert.deepEqual(store.listTranscriptMessages(thread), []);
    assert.equal(store.getTurnInput(thread, "A"), undefined);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill receipt metadata stores references only and cannot overwrite a different snapshot", () => {
  const { dir, store } = temporaryStore();
  try {
    const thread = store.createThread();
    const input = { role: "user", content: "/demo keep raw" } as const;
    store.acceptTurnInput(thread, "A", input);
    const checkpoint = {
      version: 1 as const,
      kind: "explicit-skill" as const,
      snapshot: {
        userPrompt: "keep raw",
        skillNames: ["demo"],
        skills: [{ name: "demo", source: "project", contentSha256: "a".repeat(64) }],
        modelUserContent: "SECRET_SKILL_BODY",
      },
    };
    store.recordTurnSkillCheckpoint(thread, "A", checkpoint);
    store.recordTurnSkillCheckpoint(thread, "A", checkpoint);
    const receipt = store.getTurnInput(thread, "A");
    assert.match(JSON.stringify(receipt), /contentSha256/);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /SECRET_SKILL_BODY|keep raw|userPrompt|modelUserContent/,
    );
    assert.deepEqual(
      store.listTranscriptMessages(thread)[0]?.message,
      input,
      "raw transcript remains append-only",
    );
    assert.deepEqual(store.getMessages(thread)[0], input);
    assert.throws(
      () =>
        store.recordTurnSkillCheckpoint(thread, "A", {
          ...checkpoint,
          snapshot: {
            ...checkpoint.snapshot,
            skills: [{ ...checkpoint.snapshot.skills[0]!, contentSha256: "b".repeat(64) }],
          },
        }),
      /snapshot.*conflict/i,
    );
    assert.throws(
      () => store.recordTurnSkillCheckpoint(thread, "missing", checkpoint),
      /not found/i,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v7 database upgrades additively without fabricating receipts for legacy inputs", () => {
  const { dir, store } = temporaryStore();
  const thread = store.createThread();
  store.appendMessages(thread, [message]);
  store.close();
  const db = new DatabaseSync(join(dir, "threads.db"));
  db.exec("DROP TABLE IF EXISTS thread_turn_inputs; PRAGMA user_version = 7;");
  db.close();
  const upgraded = new ThreadStore(dir);
  try {
    assert.deepEqual(upgraded.getMessages(thread), [message]);
    assert.equal(upgraded.getTurnInput(thread, "legacy"), undefined);
    upgraded.acceptTurnInput(thread, "new", message);
    assert.equal(upgraded.getTurnInput(thread, "new")?.transcriptSequence, 1);
  } finally {
    upgraded.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
