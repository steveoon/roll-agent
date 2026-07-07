import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPathArgs, isEscapingPathArg } from "./path-audit.ts";

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
  assert.equal(auditPathArgs("cat", ["cat", "~/.ssh/id_rsa"]), "reject");
  assert.equal(auditPathArgs("cat", ["cat", "/etc/passwd"]), "reject");
  assert.equal(auditPathArgs("find", ["find", "/", "-name", "x"]), "reject");
  assert.equal(auditPathArgs("tail", ["tail", "-f", "/var/log/system.log"]), "reject");
  assert.equal(auditPathArgs("ls", ["ls", "-la", "../.."]), "reject");
  assert.equal(auditPathArgs("cd", ["cd", "/tmp"]), "reject");
  assert.equal(auditPathArgs("cd", ["cd", ".."]), "reject");
  assert.equal(auditPathArgs("sed", ["sed", "-n", "1,5p", "~/.zshrc"]), "reject");
  assert.equal(auditPathArgs("base64", ["base64", "/etc/passwd"]), "reject");
  assert.equal(auditPathArgs("git", ["git", "diff", "--no-index", "/a", "/b"]), "reject");
});

test("工作区内相对路径 → safe", () => {
  assert.equal(auditPathArgs("cat", ["cat", "README.md"]), "safe");
  assert.equal(auditPathArgs("ls", ["ls", "-la"]), "safe");
  assert.equal(auditPathArgs("ls", ["ls", "src"]), "safe");
  assert.equal(auditPathArgs("find", ["find", ".", "-name", "*.ts"]), "safe");
  assert.equal(auditPathArgs("sed", ["sed", "-n", "2,5p", "file.txt"]), "safe");
  assert.equal(auditPathArgs("git", ["git", "log", "main..dev"]), "safe");
  assert.equal(auditPathArgs("git", ["git", "diff", "HEAD~1"]), "safe");
  assert.equal(auditPathArgs("cat", ["cat"]), "safe");
});

test("grep/rg 首个非 flag 参数是 pattern，豁免路径检查", () => {
  assert.equal(auditPathArgs("grep", ["grep", "/api/users", "routes.ts"]), "safe");
  assert.equal(auditPathArgs("rg", ["rg", "a..b", "src"]), "safe");
  assert.equal(auditPathArgs("grep", ["grep", "secret", "~/.zshrc"]), "reject");
  assert.equal(auditPathArgs("rg", ["rg", "secret", "/Users/someone"]), "reject");
  assert.equal(auditPathArgs("grep", ["grep", "-r", "foo", "../other"]), "reject");
});

test("非文件类命令跳过路径审计", () => {
  assert.equal(auditPathArgs("echo", ["echo", "/etc/passwd"]), "safe");
  assert.equal(auditPathArgs("which", ["which", "node"]), "safe");
  assert.equal(auditPathArgs("seq", ["seq", "1", "10"]), "safe");
  assert.equal(auditPathArgs("expr", ["expr", "1", "+", "2"]), "safe");
});
