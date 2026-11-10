import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadChatConfigBinding } from "./chat-config-binding.ts";

test("chat binds explicit resources separately from execution cwd and pins the source", () => {
  const root = mkdtempSync(join(tmpdir(), "chat binding-"));
  try {
    const source = join(root, "settings");
    const task = join(root, "task");
    mkdirSync(source);
    mkdirSync(task);
    const path = join(source, "roll.config.yaml");
    writeFileSync(path, "runtime:\n  threads-dir: ./history\nskills:\n  dirs: [./skills]\n");
    writeFileSync(join(task, "roll.config.yaml"), "runtime:\n  model: wrong-fallback\n");
    const binding = loadChatConfigBinding({ configPath: path, configWorkspace: source, cwd: task });
    assert.equal(binding.config.runtime.threadsDir, join(source, "history"));
    assert.deepEqual(binding.config.skills.dirs, [join(source, "skills")]);
    assert.equal(binding.context?.configWorkspace, resolve(source));
    writeFileSync(path, "runtime:\n  threads-dir: ./history\n  model: reloaded\n");
    assert.equal(binding.read().runtime.model, "reloaded");
    unlinkSync(path);
    assert.throws(() => binding.read(), /not found/u);
    assert.throws(() => loadChatConfigBinding({ configWorkspace: source, cwd: task }), /config/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovered chat configuration is bound for scheduler and cannot fall back after deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "chat discovered-"));
  try {
    const task = join(root, "task");
    mkdirSync(task);
    const path = join(task, "roll.config.yaml");
    writeFileSync(path, "runtime:\n  model: selected\n");
    const binding = loadChatConfigBinding({ cwd: task });
    assert.equal(binding.context?.configPath, path);
    assert.equal(binding.context?.configWorkspace, task);
    writeFileSync(join(root, "roll.config.yaml"), "runtime:\n  model: forbidden-fallback\n");
    unlinkSync(path);
    assert.throws(() => binding.read(), /not found/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
