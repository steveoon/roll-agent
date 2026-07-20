import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ruleBasedClassifier } from "./index.ts";
import { classifyScript, containsUnquotedGlob } from "./compound.ts";

const WORKDIR = resolve(import.meta.dirname, "../../../../..");
const classify = (command: string, workdir = WORKDIR) =>
  ruleBasedClassifier.classify(command, workdir);

test("known-safe：纯只读命令与安全复合", () => {
  assert.equal(classify("ls -la"), "known-safe");
  assert.equal(classify("ls && pwd"), "known-safe");
  assert.equal(classify("cat README.md | grep Roll"), "known-safe");
});

test("dangerous：rm -rf 及其复合", () => {
  assert.equal(classify("rm -rf /tmp/x"), "dangerous");
  assert.equal(classify("ls; rm -rf x"), "dangerous");
  assert.equal(classify("sudo rm -rf x"), "dangerous");
});

test("unknown：含危险元字符、非白名单、空段、未闭合引号", () => {
  assert.equal(classifyScript("echo $(whoami)", "linux"), "unknown");
  assert.equal(classifyScript("cat f > out", "linux"), "unknown");
  assert.equal(classifyScript("curl http://x", "linux"), "unknown");
  assert.equal(classifyScript("&& ls", "linux"), "unknown");
  assert.equal(classifyScript("echo 'unterminated", "linux"), "unknown");
  assert.equal(classifyScript("ls & ", "linux"), "unknown");
  assert.equal(classify("git status"), "unknown");
  assert.equal(classify('bash -lc "pwd"'), "unknown");
  assert.equal(classify("/tmp/outside/cat README.md"), "unknown");
  assert.equal(classify("./cat README.md"), "unknown");
});

test("复合命令任一段非安全则整体降级", () => {
  assert.equal(classifyScript("ls && curl http://x", "linux"), "unknown");
  assert.equal(classifyScript("git status && git commit -m x", "linux"), "unknown");
});

test("路径逃逸的只读命令降级 unknown（P1：不免确认读工作区外文件）", () => {
  assert.equal(classify("cat ~/.ssh/id_rsa"), "unknown");
  assert.equal(classify("cat /etc/passwd"), "unknown");
  assert.equal(classify("find / -name x"), "unknown");
  assert.equal(classify("tail -f /var/log/system.log"), "unknown");
  assert.equal(classify("rg secret /Users/rensiwen"), "unknown");
  assert.equal(classify("grep -f ~/.ssh/id_rsa package.json"), "unknown");
  assert.equal(classify("grep --file=~/.ssh/id_rsa package.json"), "unknown");
  assert.equal(classify("rg -f ~/.ssh/id_rsa package.json"), "unknown");
  assert.equal(classify("rg --ignore-file ~/.gitignore TODO src"), "unknown");
  assert.equal(classify("cd /etc && cat passwd"), "unknown");
  assert.equal(classify("cd subdir && cat innocent.txt"), "unknown");
  assert.equal(classify("ls && cat ../outside.txt"), "unknown");
  assert.equal(classify("rg -- -z ../outside"), "unknown");
  assert.equal(classify("grep -neTODO /etc/passwd"), "unknown");
  assert.equal(classify("grep -ne TODO /etc/passwd"), "unknown");
  assert.equal(classify("rg -neTODO /etc/passwd"), "unknown");
  assert.equal(classify("rg -ne TODO /etc/passwd"), "unknown");
  assert.equal(classify("tail -F README.md"), "unknown");
  assert.equal(classify("tail --follow=name README.md"), "unknown");
});

test("工作区内只读命令仍 known-safe（路径审计不产生噪声）", () => {
  assert.equal(classify("cat README.md"), "known-safe");
  assert.equal(classify("grep -r TODO packages"), "known-safe");
  assert.equal(classify("grep -f package.json package.json"), "known-safe");
  assert.equal(classify('find . -name "*.ts"'), "known-safe");
  assert.equal(classify("echo /etc/passwd"), "known-safe");
  assert.equal(classify("cat not-created-yet.txt"), "unknown");
});

test("未引用 glob 会经 shell 展开，因此不能自动放行", () => {
  assert.equal(containsUnquotedGlob("cat *"), true);
  assert.equal(containsUnquotedGlob('find . -name "*.ts"'), false);
  assert.equal(classify("cat *"), "unknown");
  assert.equal(classify("find . -name *.ts"), "unknown");
  assert.equal(classify('find . -name "*.ts"'), "known-safe");
});

test(
  "symlink 和 git 嵌套 workdir 不能自动放行",
  { skip: process.platform === "win32" },
  (context) => {
    const fixture = mkdtempSync(join(tmpdir(), "roll-classifier-boundary-"));
    context.after(() => rmSync(fixture, { recursive: true, force: true }));
    const repository = join(fixture, "repository");
    const nestedWorkdir = join(repository, "packages", "app");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(nestedWorkdir, { recursive: true });
    writeFileSync(join(fixture, "outside.txt"), "outside");
    writeFileSync(join(repository, "inside.txt"), "inside");
    writeFileSync(join(nestedWorkdir, "inside.txt"), "inside");
    symlinkSync("../../../outside.txt", join(nestedWorkdir, "innocent.txt"));
    symlinkSync("../outside.txt", join(repository, "innocent.txt"));

    assert.equal(classify("cat innocent.txt", nestedWorkdir), "unknown");
    assert.equal(classify("git diff --no-index innocent.txt inside.txt", repository), "unknown");
    assert.equal(classify("git show", nestedWorkdir), "unknown");
    assert.equal(classify("git log -p", nestedWorkdir), "unknown");
    assert.equal(classify("git diff HEAD~1", nestedWorkdir), "unknown");
    assert.equal(classify("git diff --no-index innocent.txt inside.txt", nestedWorkdir), "unknown");
    assert.equal(classify("git diff --no-index /etc/passwd inside.txt", nestedWorkdir), "unknown");
  },
);

test("换行分隔的多命令逐段分类，不被首命令洗白", () => {
  assert.equal(classifyScript("ls\nrm -rf /tmp/x", "linux"), "dangerous");
  assert.equal(classifyScript("ls\ncurl http://x", "linux"), "unknown");
  assert.equal(classifyScript("ls\npwd", "linux"), "known-safe");
  assert.equal(classifyScript("git status\n", "linux"), "unknown");
  assert.equal(classifyScript("ls &&\npwd", "linux"), "known-safe");
});
