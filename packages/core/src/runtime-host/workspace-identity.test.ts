import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveChatWorkspace } from "./workspace-identity.ts";

test("workspace identity uses the nearest Git root and keeps worktrees distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-workspace-"));
  try {
    const project = join(dir, "project");
    const nested = join(project, "packages", "app");
    const worktree = join(dir, "worktree");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(project, ".git", "worktrees", "other")}\n`,
    );
    assert.equal(resolveChatWorkspace(nested), realpathSync(project));
    assert.equal(resolveChatWorkspace(join(worktree, "src")), realpathSync(worktree));
    mkdirSync(join(nested, ".git"));
    assert.equal(resolveChatWorkspace(nested), realpathSync(nested));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace identity canonicalizes directory aliases and uses cwd outside Git", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-workspace-alias-"));
  try {
    const original = join(dir, "original");
    const alias = join(dir, "alias");
    mkdirSync(original);
    symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(resolveChatWorkspace(alias), realpathSync(original));
    mkdirSync(join(original, "nested"));
    assert.equal(
      resolveChatWorkspace(join(original, "nested")),
      realpathSync(join(original, "nested")),
    );
    const file = join(dir, "file");
    writeFileSync(file, "file");
    assert.throws(() => resolveChatWorkspace(file), /existing directory/u);
    assert.throws(() => resolveChatWorkspace(join(dir, "missing")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
