import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFlags } from "./flag-audit.ts";

test("find 拒绝执行/删除/写文件类 flag", () => {
  assert.equal(auditFlags("find", ["find", ".", "-name", "x"]), "safe");
  assert.equal(auditFlags("find", ["find", ".", "-delete"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-exec", "rm", "{}", ";"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-fprintf", "out", "%p"]), "reject");
});

test("grep 拒绝读取工作区外 pattern/exclude 文件", () => {
  assert.equal(auditFlags("grep", ["grep", "-r", "TODO", "src"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-f", "patterns.txt", "package.json"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-f", "~/.ssh/id_rsa", "package.json"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "-f../secret", "package.json"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "--file=~/.ssh/id_rsa", "package.json"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "--exclude-from", "/etc/passwd", "src"]), "reject");
});

test("rg 拒绝 --search-zip/-z、执行类 flag 与工作区外路径型 flag", () => {
  assert.equal(auditFlags("rg", ["rg", "foo", "-n"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-f", "patterns.txt", "package.json"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "--ignore-file", ".ignore", "TODO", "src"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-z", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--search-zip", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--pre", "cmd", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--pre=cmd", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-f", "~/.ssh/id_rsa", "package.json"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--file=~/.ssh/id_rsa", "package.json"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--ignore-file", "/tmp/ignore", "TODO", "src"]), "reject");
});

test("base64 拒绝写文件（含贴值/前缀三种写法）", () => {
  assert.equal(auditFlags("base64", ["base64", "file"]), "safe");
  assert.equal(auditFlags("base64", ["base64", "-o", "out"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "--output=out"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "-oout.txt"]), "reject");
});

test("sed 仅允许 -n {N|M,N}p", () => {
  assert.equal(auditFlags("sed", ["sed", "-n", "5p", "file"]), "safe");
  assert.equal(auditFlags("sed", ["sed", "-n", "2,5p"]), "safe");
  assert.equal(auditFlags("sed", ["sed", "-n", "s/a/b/"]), "reject");
  assert.equal(auditFlags("sed", ["sed", "-i", "s/a/b/", "file"]), "reject");
  assert.equal(auditFlags("sed", ["sed", "-n", "5p", "a", "b"]), "reject");
});

test("无审计器的命令默认 safe（交给白名单裁决）", () => {
  assert.equal(auditFlags("ls", ["ls", "-la"]), "safe");
});
