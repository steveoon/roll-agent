import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import {
  buildSegmentCaptureWrapper,
  evaluatePipelineExit,
  parsePipeSegments,
  probeShellPipeCapability,
  SIGPIPE_BENIGN_NOTE,
  SIGPIPE_EXIT_CODE,
  SIGPIPE_FALLBACK_NOTE,
} from "./shell-pipe.ts";

function spawnSyncWith(stdout: string, status: number): typeof import("node:child_process").spawnSync {
  const result = {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
  } as SpawnSyncReturns<string>;
  return (() => result) as unknown as typeof import("node:child_process").spawnSync;
}

test("probe 识别 bash 风格 PIPESTATUS", () => {
  const probe = probeShellPipeCapability("/bin/bash", spawnSyncWith("1 0|", 0));
  assert.deepEqual(probe, { capability: "segments", segmentArray: "PIPESTATUS" });
});

test("probe 识别 zsh 风格 pipestatus", () => {
  const probe = probeShellPipeCapability("/bin/zsh", spawnSyncWith("|1 0", 0));
  assert.deepEqual(probe, { capability: "segments", segmentArray: "pipestatus" });
});

test("probe 无逐段状态但 pipefail 可用时退回 pipefail", () => {
  let calls = 0;
  const spawnSync = (() => {
    calls += 1;
    return calls === 1
      ? ({ pid: 1, output: [null, "", ""], stdout: "", stderr: "bad substitution", status: 2, signal: null } as SpawnSyncReturns<string>)
      : ({ pid: 1, output: [null, "", ""], stdout: "", stderr: "", status: 1, signal: null } as SpawnSyncReturns<string>);
  }) as unknown as typeof import("node:child_process").spawnSync;
  const probe = probeShellPipeCapability("/bin/dash", spawnSync);
  assert.equal(probe.capability, "pipefail");
});

test("probe 两者都不可用时退回 none", () => {
  const spawnSync = (() => ({
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  })) as unknown as typeof import("node:child_process").spawnSync;
  const probe = probeShellPipeCapability("/bin/sh", spawnSync);
  assert.equal(probe.capability, "none");
});

test("parsePipeSegments 解析空白分隔的退出码", () => {
  assert.deepEqual(parsePipeSegments("141 0\n"), [141, 0]);
  assert.equal(parsePipeSegments(""), undefined);
  assert.equal(parsePipeSegments("abc"), undefined);
});

test("逐段判定：末段 0 且中段 SIGPIPE 判成功并附说明", () => {
  const verdict = evaluatePipelineExit({
    exitCode: 0,
    segments: [SIGPIPE_EXIT_CODE, 0],
    capability: "segments",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.effectiveExitCode, 0);
  assert.equal(verdict.note, SIGPIPE_BENIGN_NOTE);
});

test("逐段判定：中段真实失败判失败并取该段退出码", () => {
  const verdict = evaluatePipelineExit({ exitCode: 0, segments: [1, 0], capability: "segments" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.effectiveExitCode, 1);
});

test("逐段判定：观测退出码与末段不一致时以观测值为准（exit N 不误判）", () => {
  const verdict = evaluatePipelineExit({ exitCode: 7, segments: [0], capability: "segments" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.effectiveExitCode, 7);
});

test("逐段判定：末段非 0 判失败", () => {
  const verdict = evaluatePipelineExit({ exitCode: 141, segments: [0, 141], capability: "segments" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.effectiveExitCode, 141);
});

test("无逐段状态：141 标注为上游提前关闭且不视为失败", () => {
  const verdict = evaluatePipelineExit({ exitCode: SIGPIPE_EXIT_CODE, capability: "pipefail" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.note, SIGPIPE_FALLBACK_NOTE);
});

test("无逐段状态：普通非零仍失败", () => {
  const verdict = evaluatePipelineExit({ exitCode: 2, capability: "pipefail" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.effectiveExitCode, 2);
});

test("wrapper 以 EXIT trap 捕获逐段状态且不影响 stdout", () => {
  const wrapped = buildSegmentCaptureWrapper("echo hi", "PIPESTATUS");
  assert.match(wrapped, /^trap '/u);
  assert.match(wrapped, /PIPESTATUS\[\*\]/u);
  assert.match(wrapped, /ROLL_PIPE_STATUS_FILE/u);
  assert.ok(wrapped.endsWith("echo hi"));
});
