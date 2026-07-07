import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapturedStream } from "./output-buffer.ts";
import {
  EXEC_TIMEOUT_EXIT_CODE,
  formatBashResult,
  normalizeExitCode,
  type BashExecResult,
} from "./format-result.ts";

function stream(text: string, overrides: Partial<CapturedStream> = {}): CapturedStream {
  return {
    text,
    totalBytes: Buffer.byteLength(text),
    totalLines: text.length > 0 ? text.split("\n").length : 0,
    truncated: false,
    ...overrides,
  };
}

function result(overrides: Partial<BashExecResult>): BashExecResult {
  return {
    exitCode: 0,
    timedOut: false,
    timeoutMs: 10_000,
    wallTimeMs: 1234,
    stdout: stream(""),
    stderr: stream(""),
    ...overrides,
  };
}

test("normalizeExitCode: 超时归一 124", () => {
  assert.equal(
    normalizeExitCode({ timedOut: true, code: null, signalNumber: 15 }),
    EXEC_TIMEOUT_EXIT_CODE,
  );
});

test("normalizeExitCode: 正常退出码透传", () => {
  assert.equal(normalizeExitCode({ timedOut: false, code: 7, signalNumber: undefined }), 7);
});

test("normalizeExitCode: 信号映射 128+n（SIGTERM=15→143, SIGKILL=9→137）", () => {
  assert.equal(normalizeExitCode({ timedOut: false, code: null, signalNumber: 15 }), 143);
  assert.equal(normalizeExitCode({ timedOut: false, code: null, signalNumber: 9 }), 137);
});

test("normalizeExitCode: 无 code 无 signal 兜底 1", () => {
  assert.equal(normalizeExitCode({ timedOut: false, code: null, signalNumber: undefined }), 1);
});

test("成功命令输出含 Exit code 与 Wall time 前缀", () => {
  const formatted = formatBashResult({
    result: result({ stdout: stream("hello") }),
    maxModelOutputChars: 1000,
  });
  assert.equal(formatted.isError, false);
  assert.ok(String(formatted.output).includes("Exit code: 0"));
  assert.ok(String(formatted.output).includes("Wall time: 1.2 s"));
  assert.ok(String(formatted.output).includes("[stdout]\nhello"));
});

test("非零退出码标记 isError", () => {
  const formatted = formatBashResult({
    result: result({ exitCode: 2 }),
    maxModelOutputChars: 1000,
  });
  assert.equal(formatted.isError, true);
});

test("超时输出带说明行且 exit 124", () => {
  const formatted = formatBashResult({
    result: result({ timedOut: true, exitCode: 124, timeoutMs: 500 }),
    maxModelOutputChars: 1000,
  });
  assert.ok(String(formatted.output).includes("命令超时（超过 500ms）"));
  assert.ok(String(formatted.output).includes("Exit code: 124"));
});

test("捕获截断时输出警告头含原始行数", () => {
  const formatted = formatBashResult({
    result: result({
      stdout: stream("kept", { truncated: true, totalBytes: 999999, totalLines: 4000 }),
    }),
    maxModelOutputChars: 1000,
  });
  assert.ok(String(formatted.output).includes("Warning: stdout 输出已截断"));
  assert.ok(String(formatted.output).includes("4000 行"));
});

test("spawnError 直接返回错误", () => {
  const formatted = formatBashResult({
    result: result({ spawnError: "spawn /bin/nope ENOENT" }),
    maxModelOutputChars: 1000,
  });
  assert.equal(formatted.isError, true);
  assert.ok(String(formatted.output).includes("命令无法启动"));
});

test("空 stderr 不渲染 stderr 段", () => {
  const formatted = formatBashResult({
    result: result({ stdout: stream("out") }),
    maxModelOutputChars: 1000,
  });
  assert.ok(!String(formatted.output).includes("[stderr]"));
});
