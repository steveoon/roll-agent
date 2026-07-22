import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditPathArgs, isEscapingPathArg } from "./path-audit.ts";

const WORKDIR = resolve(import.meta.dirname, "../../../../..");

test("isEscapingPathArg 识别绝对路径、~ 与 .. 路径段", () => {
  assert.equal(isEscapingPathArg("/etc/passwd"), true);
  assert.equal(isEscapingPathArg("~/.ssh/id_rsa"), true);
  assert.equal(isEscapingPathArg("~"), true);
  assert.equal(isEscapingPathArg(".."), true);
  assert.equal(isEscapingPathArg("../secrets"), true);
  assert.equal(isEscapingPathArg("a/../../b"), true);
  assert.equal(isEscapingPathArg("README.md"), false);
  assert.equal(isEscapingPathArg("src/index.ts"), false);
  assert.equal(isEscapingPathArg("a..b"), false);
  assert.equal(isEscapingPathArg("HEAD~1..HEAD"), false);
  assert.equal(isEscapingPathArg("main..dev"), false);
});

test("路径命令带逃逸参数 → reject", () => {
  assert.equal(auditPathArgs("cat", ["cat", "~/.ssh/id_rsa"], WORKDIR), "reject");
  assert.equal(auditPathArgs("cat", ["cat", "/etc/passwd"], WORKDIR), "reject");
  assert.equal(auditPathArgs("find", ["find", "/", "-name", "x"], WORKDIR), "reject");
  assert.equal(auditPathArgs("tail", ["tail", "-f", "/var/log/system.log"], WORKDIR), "reject");
  assert.equal(auditPathArgs("ls", ["ls", "-la", "../.."], WORKDIR), "reject");
  assert.equal(auditPathArgs("cd", ["cd", "/tmp"], WORKDIR), "reject");
  assert.equal(auditPathArgs("cd", ["cd", ".."], WORKDIR), "reject");
  assert.equal(auditPathArgs("sed", ["sed", "-n", "1,5p", "~/.zshrc"], WORKDIR), "reject");
  assert.equal(auditPathArgs("base64", ["base64", "/etc/passwd"], WORKDIR), "reject");
  assert.equal(auditPathArgs("git", ["git", "diff", "--no-index", "/a", "/b"], WORKDIR), "reject");
});

test("工作区内相对路径 → safe", () => {
  assert.equal(auditPathArgs("cat", ["cat", "README.md"], WORKDIR), "safe");
  assert.equal(auditPathArgs("ls", ["ls", "-la"], WORKDIR), "safe");
  assert.equal(auditPathArgs("ls", ["ls", "packages"], WORKDIR), "safe");
  assert.equal(auditPathArgs("find", ["find", ".", "-name", "*.ts"], WORKDIR), "safe");
  assert.equal(auditPathArgs("sed", ["sed", "-n", "2,5p", "README.md"], WORKDIR), "safe");
  assert.equal(auditPathArgs("git", ["git", "log", "main..dev"], WORKDIR), "reject");
  assert.equal(auditPathArgs("git", ["git", "diff", "HEAD~1"], WORKDIR), "reject");
  assert.equal(auditPathArgs("cat", ["cat"], WORKDIR), "safe");
  assert.equal(auditPathArgs("cat", ["cat", "not-created-yet.txt"], WORKDIR), "reject");
});

test("grep/rg 首个非 flag 参数是 pattern，豁免路径检查", () => {
  assert.equal(auditPathArgs("grep", ["grep", "/api/users", "package.json"], WORKDIR), "safe");
  assert.equal(auditPathArgs("rg", ["rg", "a..b", "packages"], WORKDIR), "safe");
  assert.equal(auditPathArgs("grep", ["grep", "secret", "~/.zshrc"], WORKDIR), "reject");
  assert.equal(auditPathArgs("rg", ["rg", "secret", "/Users/someone"], WORKDIR), "reject");
  assert.equal(auditPathArgs("grep", ["grep", "-r", "foo", "../other"], WORKDIR), "reject");
  assert.equal(auditPathArgs("rg", ["rg", "--", "-z", "../outside"], WORKDIR), "reject");
});

test("非文件类命令跳过路径审计", () => {
  assert.equal(auditPathArgs("echo", ["echo", "/etc/passwd"], WORKDIR), "safe");
  assert.equal(auditPathArgs("which", ["which", "node"], WORKDIR), "safe");
  assert.equal(auditPathArgs("seq", ["seq", "1", "10"], WORKDIR), "safe");
  assert.equal(auditPathArgs("expr", ["expr", "1", "+", "2"], WORKDIR), "safe");
});

test(
  "存在于工作区内但 realpath 越界的 symlink → reject",
  { skip: process.platform === "win32" },
  (context) => {
    const fixture = mkdtempSync(join(tmpdir(), "roll-path-audit-"));
    context.after(() => rmSync(fixture, { recursive: true, force: true }));
    const workdir = join(fixture, "workspace");
    const outsideDir = join(fixture, "outside");
    mkdirSync(workdir);
    mkdirSync(outsideDir);
    writeFileSync(join(fixture, "outside.txt"), "outside");
    writeFileSync(join(workdir, "inside.txt"), "inside");
    symlinkSync("../outside.txt", join(workdir, "innocent.txt"));
    symlinkSync("../outside", join(workdir, "escape"));

    assert.equal(auditPathArgs("cat", ["cat", "inside.txt"], workdir), "safe");
    assert.equal(auditPathArgs("cat", ["cat", "innocent.txt"], workdir), "reject");
    assert.equal(auditPathArgs("cat", ["cat", "escape/late-secret.txt"], workdir), "reject");
    assert.equal(
      auditPathArgs("grep", ["grep", "-f", "innocent.txt", "inside.txt"], workdir),
      "reject",
    );
  },
);
