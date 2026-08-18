import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapturedStream } from "./output-buffer.ts";
import {
  BASH_TERMINATION_CAUSES,
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

test("用户取消明确标记 aborted，不与正常 exit 0 混淆", () => {
  const formatted = formatBashResult({
    result: result({
      exitCode: 130,
      terminationCause: BASH_TERMINATION_CAUSES.abort,
    }),
    maxModelOutputChars: 1000,
  });
  assert.equal(formatted.isError, true);
  assert.match(String(formatted.output), /命令已中断/);
  assert.match(String(formatted.output), /不能视为正常完成/);
  assert.match(String(formatted.output), /Exit code: 130/);
});

test("超时输出带说明行且 exit 124", () => {
  const formatted = formatBashResult({
    result: result({ timedOut: true, exitCode: 124, timeoutMs: 500 }),
    maxModelOutputChars: 1000,
  });
  assert.ok(String(formatted.output).includes("命令超时（超过 500ms）"));
  assert.ok(String(formatted.output).includes("Exit code: 124"));
});

test("tree fallback 后 root 已退出也不伪报全部已终止", () => {
  const formatted = formatBashResult({
    result: result({
      timedOut: true,
      exitCode: 124,
      timeoutMs: 500,
      terminationError: "taskkill 失败；根进程已退出，但无法确认后代进程是否已清理",
    }),
    maxModelOutputChars: 1000,
  });
  const output = String(formatted.output);
  assert.ok(output.includes("命令超时（超过 500ms），终止状态未确认"));
  assert.ok(output.includes("终止失败: taskkill 失败"));
  assert.ok(output.includes("无法确认后代进程是否已清理"));
  assert.ok(!output.includes("已终止"));
  assert.equal(formatted.isError, true);
});

test("forced-settle 同时显示根进程与后代进程均未确认", () => {
  const formatted = formatBashResult({
    result: result({
      exitCode: 130,
      terminationError:
        "taskkill 失败；无法确认后代进程是否已清理；根进程在强制终止请求后仍未确认退出",
    }),
    maxModelOutputChars: 1000,
  });
  const output = String(formatted.output);
  assert.ok(output.includes("无法确认后代进程是否已清理"));
  assert.ok(output.includes("根进程在强制终止请求后仍未确认退出"));
  assert.ok(!output.includes("命令超时"));
  assert.equal(formatted.isError, true);
});

test("terminationError 在退出码为 0 时也标记 isError", () => {
  const formatted = formatBashResult({
    result: result({ exitCode: 0, terminationError: "进程树清理未完成" }),
    maxModelOutputChars: 1000,
  });
  assert.equal(formatted.isError, true);
});

test("捕获截断时落盘完整捕获输出并给出分页恢复指引", () => {
  let dumped: string | undefined;
  const formatted = formatBashResult({
    result: result({
      stdout: stream("kept", { truncated: true, totalBytes: 999999, totalLines: 4000 }),
    }),
    maxModelOutputChars: 1000,
    fullOutputSink: (text) => {
      dumped = text;
      return "/tmp/roll-bash-fake.log";
    },
  });
  const output = String(formatted.output);
  assert.ok(output.includes("Warning: stdout 输出已截断"));
  assert.ok(output.includes("4000 行"));
  assert.ok(output.includes("完整输出已落盘: /tmp/roll-bash-fake.log"));
  assert.match(output, /roll__read_file 以 offset\/limit 分页/u);
  assert.equal(dumped, "[stdout]\nkept");
});

test("模型预算截断时同样落盘并指引恢复", () => {
  const big = "z".repeat(5_000);
  let dumped: string | undefined;
  const formatted = formatBashResult({
    result: result({ stdout: stream(big) }),
    maxModelOutputChars: 1_000,
    fullOutputSink: (text) => {
      dumped = text;
      return "/tmp/roll-bash-budget.log";
    },
  });
  const output = String(formatted.output);
  assert.match(output, /chars truncated（保留前/u);
  assert.ok(output.includes("完整输出已落盘: /tmp/roll-bash-budget.log"));
  assert.ok(dumped !== undefined && dumped.includes(big));
});

test("未截断时不触发落盘", () => {
  let called = false;
  formatBashResult({
    result: result({ stdout: stream("hello") }),
    maxModelOutputChars: 1_000,
    fullOutputSink: () => {
      called = true;
      return undefined;
    },
  });
  assert.equal(called, false);
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
