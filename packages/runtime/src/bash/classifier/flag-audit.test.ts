import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFlags } from "./flag-audit.ts";

test("find 拒绝执行/删除/写文件类 flag", () => {
  assert.equal(auditFlags("find", ["find", ".", "-name", "x"]), "safe");
  assert.equal(auditFlags("find", ["find", ".", "-type", "f", "-print"]), "safe");
  assert.equal(auditFlags("find", ["find", "-L", ".", "-name", "x"]), "reject");
  assert.equal(auditFlags("find", ["find", "-H", ".", "-name", "x"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-follow", "-name", "x"]), "reject");
  assert.equal(auditFlags("find", ["find", "--", ".", "-follow"]), "reject");
  assert.equal(auditFlags("find", ["find", "--", ".", "-delete"]), "reject");
  assert.equal(auditFlags("find", ["find", "--", ".", "-exec", "echo", "{}", ";"]), "reject");
  assert.equal(auditFlags("find", ["find", "-files0-from", "/tmp/list"]), "reject");
  assert.equal(auditFlags("find", ["find", "-files0-from=/tmp/list"]), "reject");
  assert.equal(auditFlags("find", ["find", "--", "-L"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-delete"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-exec", "rm", "{}", ";"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-fprintf", "out", "%p"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-newer", "/etc/passwd"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-samefile", "/etc/passwd"]), "reject");
  assert.equal(auditFlags("find", ["find", ".", "-unknown-predicate", "x"]), "reject");
});

test("grep 只接受精确的常用 flag，拒绝 symlink 跟随与模糊缩写", () => {
  assert.equal(auditFlags("grep", ["grep", "-r", "TODO", "src"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-R", "TODO", "src"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "-nR", "TODO", "src"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "-Rn", "TODO", "src"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "--dereference-recursive", "TODO", "src"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "--dereference", "-r", "TODO", "src"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "--dereference-r", "-r", "TODO", "src"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "--binary-f", "text", "src"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "-f", "patterns.txt", "package.json"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-nf../secret", "package.json"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "-nfpatterns.txt", "package.json"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "--", "-R"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-eR", "src"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-e", "-R", "src"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-f", "-R", "src"]), "safe");
  assert.equal(auditFlags("grep", ["grep", "-nePATTERN", "/tmp/outside"]), "reject");
  assert.equal(auditFlags("grep", ["grep", "-ne", "PATTERN", "/tmp/outside"]), "reject");
});

test("rg 只接受精确的常用 flag，拒绝跟随、预处理与模糊缩写", () => {
  assert.equal(auditFlags("rg", ["rg", "foo", "-n"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-f", "patterns.txt", "package.json"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "--ignore-file", ".ignore", "TODO", "src"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-z", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-az", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-za", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-L", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-nL", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-Ln", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--search-zip", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--follow", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--pre", "cmd", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--pre=cmd", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "--max-dep", "2", "foo"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-nf../secret", "package.json"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-nfpatterns.txt", "package.json"]), "reject");
});

test("rg 只审计 -- 之前的选项且不把短选项值中的 z 当作 -z", () => {
  assert.equal(auditFlags("rg", ["rg", "--", "-z"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "foo", "--", "--search-zip"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "--", "-f", "~/.ssh/id_rsa"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-g*.zip", "foo"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-fpatterns.zip", "foo"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-e-z", "src"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-d2z", "foo"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-gL", "foo"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "--", "-L"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-e", "-L", "src"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-f", "-L", "src"]), "safe");
  assert.equal(auditFlags("rg", ["rg", "-nePATTERN", "/tmp/outside"]), "reject");
  assert.equal(auditFlags("rg", ["rg", "-ne", "PATTERN", "/tmp/outside"]), "reject");
});

test("base64 拒绝写文件（含贴值/前缀三种写法）", () => {
  assert.equal(auditFlags("base64", ["base64", "file"]), "safe");
  assert.equal(auditFlags("base64", ["base64", "-i", "/tmp/input"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "-di/tmp/input"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "--input", "/tmp/input"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "--input=/tmp/input"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "-o", "out"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "--output=out"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "-oout.txt"]), "reject");
  assert.equal(auditFlags("base64", ["base64", "--", "--input"]), "safe");
});

test("ls 拒绝递归解引用 symlink 的 flag", () => {
  assert.equal(auditFlags("ls", ["ls", "-la"]), "safe");
  assert.equal(auditFlags("ls", ["ls", "-L", "."]), "reject");
  assert.equal(auditFlags("ls", ["ls", "-laL", "."]), "reject");
  assert.equal(auditFlags("ls", ["ls", "-Lla", "."]), "reject");
  assert.equal(auditFlags("ls", ["ls", "--dereference", "."]), "reject");
  assert.equal(auditFlags("ls", ["ls", "--", "-L"]), "safe");
});

test("wc 拒绝从文件或 stdin 注入待读取路径", () => {
  assert.equal(auditFlags("wc", ["wc", "package.json"]), "safe");
  assert.equal(auditFlags("wc", ["wc", "--files0-from", "/tmp/list"]), "reject");
  assert.equal(auditFlags("wc", ["wc", "--files0-from=/tmp/list"]), "reject");
  assert.equal(auditFlags("wc", ["wc", "--files0-from=-"]), "reject");
  assert.equal(auditFlags("wc", ["wc", "--files0=/tmp/list"]), "reject");
  assert.equal(auditFlags("wc", ["wc", "--files0-f=/tmp/list"]), "reject");
  assert.equal(auditFlags("wc", ["wc", "--", "--files0-from=/tmp/list"]), "safe");
});

test("tail 拒绝会按名称重新打开 symlink 的 follow/retry 选项", () => {
  assert.equal(auditFlags("tail", ["tail", "-f", "inside.log"]), "safe");
  assert.equal(auditFlags("tail", ["tail", "-F", "inside.log"]), "reject");
  assert.equal(auditFlags("tail", ["tail", "--follow=name", "inside.log"]), "reject");
  assert.equal(auditFlags("tail", ["tail", "--fol=name", "inside.log"]), "reject");
  assert.equal(auditFlags("tail", ["tail", "--retry", "inside.log"]), "reject");
  assert.equal(auditFlags("tail", ["tail", "--", "-F"]), "safe");
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
