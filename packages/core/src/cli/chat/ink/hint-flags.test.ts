import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileHintFlagStore, createInMemoryHintFlagStore } from "./hint-flags.ts";

test("内存 store 只在当前实例内记住标志", () => {
  const store = createInMemoryHintFlagStore();
  assert.equal(store.isShown("copy-round"), false);
  store.markShown("copy-round");
  assert.equal(store.isShown("copy-round"), true);
  assert.equal(createInMemoryHintFlagStore().isShown("copy-round"), false);
});

test("文件 store 跨实例持久化标志", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-hints-"));
  const filePath = join(dir, "nested", "chat-hints.json");
  try {
    const store = createFileHintFlagStore(filePath);
    assert.equal(store.isShown("mouse-release"), false);
    store.markShown("mouse-release");
    store.markShown("copy-round");
    const reloaded = createFileHintFlagStore(filePath);
    assert.equal(reloaded.isShown("mouse-release"), true);
    assert.equal(reloaded.isShown("copy-round"), true);
    assert.equal(reloaded.isShown("other"), false);
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(parsed, { shown: ["mouse-release", "copy-round"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件 store 对损坏内容回退为空集合", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-hints-"));
  const filePath = join(dir, "chat-hints.json");
  try {
    const store = createFileHintFlagStore(filePath);
    store.markShown("a");
    writeFileSync(filePath, "not json");
    assert.equal(createFileHintFlagStore(filePath).isShown("a"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
