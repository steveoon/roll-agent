import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WORKSPACE_INSTRUCTIONS_MAX_CHARS,
  createWorkspaceInstructionsSource,
  findWorkspaceInstructionsPath,
  parseWorkspaceInstructionsSetting,
} from "./workspace-instructions.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-instructions-"));
}

test("parseWorkspaceInstructionsSetting 区分 auto / off / 路径", () => {
  assert.deepEqual(parseWorkspaceInstructionsSetting("auto", "/w"), { kind: "auto" });
  assert.deepEqual(parseWorkspaceInstructionsSetting(" off ", "/w"), { kind: "off" });
  assert.deepEqual(parseWorkspaceInstructionsSetting("docs/RULES.md", "/w"), {
    kind: "path",
    path: resolve("/w", "docs/RULES.md"),
  });
  assert.deepEqual(parseWorkspaceInstructionsSetting("/abs/RULES.md", "/w"), {
    kind: "path",
    path: resolve("/abs/RULES.md"),
  });
});

test("findWorkspaceInstructionsPath 同目录 AGENTS.md 优先于 CLAUDE.md", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "claude\n");
    writeFileSync(join(dir, "AGENTS.md"), "agents\n");
    assert.equal(findWorkspaceInstructionsPath(dir), join(dir, "AGENTS.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWorkspaceInstructionsPath 只有 CLAUDE.md 时选它，并向上查找最近一层", () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "AGENTS.md"), "root agents\n");
    const mid = join(root, "mid");
    const leaf = join(mid, "leaf");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(mid, "CLAUDE.md"), "mid claude\n");
    assert.equal(findWorkspaceInstructionsPath(leaf), join(mid, "CLAUDE.md"));
    assert.equal(findWorkspaceInstructionsPath(mid), join(mid, "CLAUDE.md"));
    assert.equal(findWorkspaceInstructionsPath(root), join(root, "AGENTS.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findWorkspaceInstructionsPath 目录是文件名同名目录时跳过", () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "AGENTS.md"));
    assert.equal(findWorkspaceInstructionsPath(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 在 auto 模式下返回内容，未变化时返回同一引用，变化后重读", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "rule one\n");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "auto" },
      onIssue: (message) => issues.push(message),
    });
    const first = source.current();
    assert.ok(first);
    assert.equal(first.path, path);
    assert.equal(first.content, "rule one");
    assert.equal(first.truncated, false);
    assert.equal(first.totalChars, "rule one".length);
    assert.equal(source.current(), first);

    writeFileSync(path, "rule one\nrule two\n");
    utimesSync(path, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const second = source.current();
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.content, "rule one\nrule two");
    assert.deepEqual(issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 文件消失后返回 undefined，重新出现后再次注入", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "rules\n");
    const source = createWorkspaceInstructionsSource({ cwd: dir, setting: { kind: "auto" } });
    assert.ok(source.current());
    rmSync(path);
    assert.equal(source.current(), undefined);
    writeFileSync(path, "rules again\n");
    assert.equal(source.current()?.content, "rules again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 空文件视为没有约定，不告警", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "\n  \n");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "auto" },
      onIssue: (message) => issues.push(message),
    });
    assert.equal(source.current(), undefined);
    assert.deepEqual(issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 超过上限时截断并只告警一次", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "x".repeat(50));
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "auto" },
      maxChars: 20,
      onIssue: (message) => issues.push(message),
    });
    const value = source.current();
    assert.ok(value);
    assert.equal(value.truncated, true);
    assert.equal(value.content, "x".repeat(20));
    assert.equal(value.totalChars, 50);
    source.current();
    source.current();
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /共 50 字符/u);
    assert.match(issues[0] ?? "", /超过上限 20/u);
    assert.match(issues[0] ?? "", /请精简该文件/u);
    assert.ok(issues[0]?.includes(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("默认上限为 32000 字符", () => {
  assert.equal(WORKSPACE_INSTRUCTIONS_MAX_CHARS, 32_000);
});

test("source.current() 显式路径缺失时告警一次并返回 undefined，文件出现后生效", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "docs", "RULES.md");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "path", path },
      onIssue: (message) => issues.push(message),
    });
    assert.equal(source.current(), undefined);
    assert.equal(source.current(), undefined);
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /chat\.instructions/u);
    assert.ok(issues[0]?.includes(path));
    mkdirSync(join(dir, "docs"));
    writeFileSync(path, "explicit rules\n");
    assert.equal(source.current()?.content, "explicit rules");
    assert.equal(issues.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 显式路径优先于 auto 发现", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "auto rules\n");
    const explicit = join(dir, "RULES.md");
    writeFileSync(explicit, "explicit rules\n");
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "path", path: explicit },
    });
    assert.equal(source.current()?.path, explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 在 off 模式下永远返回 undefined", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "rules\n");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "off" },
      onIssue: (message) => issues.push(message),
    });
    assert.equal(source.current(), undefined);
    assert.deepEqual(issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
