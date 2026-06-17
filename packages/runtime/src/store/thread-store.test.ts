import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { ThreadStore } from "./thread-store.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-threads-"));
}

test("ThreadStore 创建与查询 thread", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread({ title: "t1", model: "m1" });
    assert.ok(store.hasThread(id));
    const record = store.getThread(id);
    assert.equal(record?.title, "t1");
    assert.equal(record?.model, "m1");
    assert.equal(store.hasThread("nope"), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore append/get messages 保序且可多次追加", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread();
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    store.appendMessages(id, messages);
    store.appendMessages(id, [{ role: "user", content: "again" }]);
    const got = store.getMessages(id);
    assert.equal(got.length, 3);
    assert.equal(got[0]?.role, "user");
    assert.equal(got[1]?.role, "assistant");
    assert.equal(got[2]?.role, "user");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore resume round-trip 跨实例持久化", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir);
    const id = first.createThread({ title: "persist" });
    first.appendMessages(id, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    first.close();

    const second = new ThreadStore(dir);
    assert.ok(second.hasThread(id));
    const got = second.getMessages(id);
    assert.equal(got.length, 2);
    assert.equal(got[0]?.role, "user");
    const threads = second.listThreads();
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.title, "persist");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore countMessages 与 listThreads 按最近优先（rowid tiebreaker）", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const first = store.createThread({ title: "first" });
    store.appendMessages(first, [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    const second = store.createThread({ title: "second" });
    store.appendMessages(second, [{ role: "user", content: "c" }]);

    assert.equal(store.countMessages(first), 2);
    assert.equal(store.countMessages(second), 1);

    const threads = store.listThreads();
    assert.equal(threads[0]?.id, second);
    assert.equal(threads[1]?.id, first);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore updateTitle 更新标题", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread();
    assert.equal(store.getThread(id)?.title, undefined);
    store.updateTitle(id, "新标题");
    assert.equal(store.getThread(id)?.title, "新标题");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore deleteThread 删除 thread 并级联消息", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread({ title: "delete-me" });
    store.appendMessages(id, [{ role: "user", content: "hi" }]);

    store.deleteThread(id);

    assert.equal(store.hasThread(id), false);
    assert.equal(store.countMessages(id), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 不允许向不存在的 thread 追加消息", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    assert.throws(
      () => store.appendMessages("missing", [{ role: "user", content: "hi" }]),
      /不存在/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
