import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWindowsDirectory,
  resolveWindowsPowerShellExecutable,
  resolveWindowsScheduledTasksExecutable,
} from "./windows-system.ts";

test("Windows system tools resolve beneath an absolute local Windows directory", () => {
  assert.equal(resolveWindowsDirectory("d:\\windows\\"), "d:\\windows\\");
  assert.equal(
    resolveWindowsPowerShellExecutable("D:\\Windows"),
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(
    resolveWindowsScheduledTasksExecutable("D:\\Windows"),
    "D:\\Windows\\System32\\schtasks.exe",
  );
});

test("Windows system tools reject relative and UNC directories", () => {
  assert.throws(() => resolveWindowsDirectory("Windows"), /absolute local drive/u);
  assert.throws(() => resolveWindowsDirectory("\\\\server\\Windows"), /absolute local drive/u);
});
