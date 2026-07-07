import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleBasedClassifier, unwrapShellWrapper } from "./index.ts";
import { classifyScript } from "./compound.ts";

test("unwrapShellWrapper 剥离 shell -lc/-c 包装", () => {
  assert.equal(unwrapShellWrapper('bash -lc "ls -la"', "linux"), "ls -la");
  assert.equal(unwrapShellWrapper("sh -c 'git status'", "linux"), "git status");
  assert.equal(unwrapShellWrapper("/bin/zsh -lc 'pwd'", "linux"), "pwd");
  assert.equal(unwrapShellWrapper("ls -la", "linux"), "ls -la");
});

test("known-safe：纯只读命令与安全复合", () => {
  assert.equal(ruleBasedClassifier.classify("ls -la", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify("git status", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify("ls && pwd", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify("cat a | grep b", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify('bash -lc "git status"', ""), "known-safe");
});

test("dangerous：rm -rf 及其复合", () => {
  assert.equal(ruleBasedClassifier.classify("rm -rf /tmp/x", ""), "dangerous");
  assert.equal(ruleBasedClassifier.classify("ls; rm -rf x", ""), "dangerous");
  assert.equal(ruleBasedClassifier.classify("sudo rm -rf x", ""), "dangerous");
});

test("unknown：含危险元字符、非白名单、空段、未闭合引号", () => {
  assert.equal(classifyScript("echo $(whoami)", "linux"), "unknown");
  assert.equal(classifyScript("cat f > out", "linux"), "unknown");
  assert.equal(classifyScript("curl http://x", "linux"), "unknown");
  assert.equal(classifyScript("&& ls", "linux"), "unknown");
  assert.equal(classifyScript("echo 'unterminated", "linux"), "unknown");
  assert.equal(classifyScript("ls & ", "linux"), "unknown");
});

test("复合命令任一段非安全则整体降级", () => {
  assert.equal(classifyScript("ls && curl http://x", "linux"), "unknown");
  assert.equal(classifyScript("git status && git commit -m x", "linux"), "unknown");
});

test("路径逃逸的只读命令降级 unknown（P1：不免确认读工作区外文件）", () => {
  assert.equal(ruleBasedClassifier.classify("cat ~/.ssh/id_rsa", ""), "unknown");
  assert.equal(ruleBasedClassifier.classify("cat /etc/passwd", ""), "unknown");
  assert.equal(ruleBasedClassifier.classify("find / -name x", ""), "unknown");
  assert.equal(ruleBasedClassifier.classify("tail -f /var/log/system.log", ""), "unknown");
  assert.equal(ruleBasedClassifier.classify("rg secret /Users/rensiwen", ""), "unknown");
  assert.equal(ruleBasedClassifier.classify("cd /etc && cat passwd", ""), "unknown");
  assert.equal(ruleBasedClassifier.classify("ls && cat ../outside.txt", ""), "unknown");
});

test("工作区内只读命令仍 known-safe（路径审计不产生噪声）", () => {
  assert.equal(ruleBasedClassifier.classify("cat README.md", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify("grep -r TODO src", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify("find . -name *.ts", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify("git log main..dev", ""), "known-safe");
  assert.equal(ruleBasedClassifier.classify("echo /etc/passwd", ""), "known-safe");
});

test("换行分隔的多命令逐段分类，不被首命令洗白", () => {
  assert.equal(classifyScript("ls\nrm -rf /tmp/x", "linux"), "dangerous");
  assert.equal(classifyScript("ls\ncurl http://x", "linux"), "unknown");
  assert.equal(classifyScript("ls\npwd", "linux"), "known-safe");
  assert.equal(classifyScript("git status\n", "linux"), "known-safe");
  assert.equal(classifyScript("ls &&\npwd", "linux"), "known-safe");
});
