#!/usr/bin/env node
/** End-to-end helper chain for dual-draft judge + send payload (no roll). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(path.join(tmpdir(), "roll-zhipin-pipeline-"));

function run(name, input = "", args = []) {
  const result = spawnSync("node", [path.join(dir, name), ...args], {
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${name} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

try {
  const previewOut = JSON.stringify({
    success: true,
    preparedReplyId: "prep_pipeline",
    replyVariantSelection: {
      options: [
        { option: "option_1", suggestedReply: "A" },
        { option: "option_2", suggestedReply: "B" },
      ],
    },
  });
  const previewMeta = JSON.parse(run("parse-generate-preview.mjs", previewOut));
  assert.equal(previewMeta.preparedReplyId, "prep_pipeline");
  assert.equal(previewMeta.hasDualDraft, true);

  const judgeOut = JSON.stringify({
    success: true,
    variantDecision: {
      chosenOption: "option_2",
      reason: "更清晰",
      confirmedFindingCodes: [],
      judgeModel: "mcp-sampling",
    },
  });
  const bundleRaw = run(
    "build-send-payload.mjs",
    judgeOut,
    ["prep_pipeline", "1", "0"],
  );
  const bundle = JSON.parse(bundleRaw);
  assert.equal(bundle.sendInput.preparedReplyId, "prep_pipeline");
  assert.equal(bundle.sendInput.variantDecision.chosenOption, "option_2");
  assert.equal(bundle.meta.chosenOption, "option_2");

  const spPath = path.join(workDir, "sp.json");
  run("apply-send-bundle.mjs", bundleRaw, [spPath]);
  const sp = JSON.parse(readFileSync(spPath, "utf8"));
  assert.equal(sp.variantDecision.chosenOption, "option_2");

  writeFileSync(path.join(workDir, "send-bundle.json"), bundleRaw, "utf8");
  const sendResultRaw = JSON.stringify({ ok: true, feedbackStatus: "accepted" });
  writeFileSync(path.join(workDir, "send-result.json"), sendResultRaw, "utf8");
  const composed = run("compose-result-input.mjs", "", [
    path.join(workDir, "send-bundle.json"),
    path.join(workDir, "send-result.json"),
  ]);
  const resultLine = run(
    "format-candidate-result.mjs",
    composed,
    ["sent", "ts1", "Alice", "cid1", "prep_pipeline", "1"],
  );
  const result = JSON.parse(resultLine);
  assert.equal(result.ok, true);
  assert.equal(result.chosenOption, "option_2");
  assert.equal(result.feedbackStatus, "accepted");
  assert.equal(result.exchangedWechat, true);

  const noJudgeBundle = JSON.parse(
    run("build-send-payload.mjs", "", ["prep_pipeline", "1", "1"]),
  );
  assert.equal(noJudgeBundle.meta.judgeSkipped, true);
  assert.equal(noJudgeBundle.sendInput.variantDecision, undefined);

  const judgeInputPath = path.join(workDir, "judge.json");
  run("write-judge-input.mjs", "", [judgeInputPath, "prep_pipeline"]);
  assert.deepEqual(JSON.parse(readFileSync(judgeInputPath, "utf8")), {
    preparedReplyId: "prep_pipeline",
  });

  const judgeFatal = spawnSync(
    "node",
    [path.join(dir, "build-send-payload.mjs"), "prep_pipeline", "1", "0"],
    {
      input: JSON.stringify({ success: false, error: "preparedReplyId 已过期" }),
      encoding: "utf8",
    },
  );
  assert.equal(judgeFatal.status, 4, "judge hard failure should abort send_build");

  console.log("pipeline-judge-send.test.mjs: ok");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
