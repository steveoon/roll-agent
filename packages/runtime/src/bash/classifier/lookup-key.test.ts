import { test } from "node:test";
import assert from "node:assert/strict";
import { executableLookupKey } from "./lookup-key.ts";

test("basename 提取绝对路径的可执行名", () => {
  assert.equal(executableLookupKey("/usr/bin/git", "linux"), "git");
  assert.equal(executableLookupKey("git", "linux"), "git");
  assert.equal(executableLookupKey("./bin/ls", "darwin"), "ls");
});

test("win32 剥离 .exe/.cmd/.bat/.com 并小写", () => {
  assert.equal(executableLookupKey("C:\\\\Windows\\\\GIT.EXE", "win32"), "git");
  assert.equal(executableLookupKey("Rm.cmd", "win32"), "rm");
  assert.equal(executableLookupKey("Foo.bat", "win32"), "foo");
});

test("非 win32 保留大小写与后缀", () => {
  assert.equal(executableLookupKey("git.exe", "linux"), "git.exe");
});
