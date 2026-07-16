#!/usr/bin/env node
/** End-to-end helper chain for send-owned dual-draft Judge + feedback metadata (no roll). */
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

function runResult(name, input = "", args = []) {
  return spawnSync("node", [path.join(dir, name), ...args], {
    input,
    encoding: "utf8",
  });
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

  const bundleRaw = run("build-send-payload.mjs", "", ["prep_pipeline", "1", "0"]);
  const bundle = JSON.parse(bundleRaw);
  assert.deepEqual(bundle.sendInput, { preparedReplyId: "prep_pipeline" });
  assert.equal(bundle.meta.hasDualDraft, true);
  assert.equal(bundle.meta.judgeAttempted, false);
  assert.equal(bundle.meta.decisionSource, null);
  assert.equal(bundle.meta.feedbackExpected, true);

  const spPath = path.join(workDir, "sp.json");
  run("apply-send-bundle.mjs", bundleRaw, [spPath]);
  assert.deepEqual(JSON.parse(readFileSync(spPath, "utf8")), {
    preparedReplyId: "prep_pipeline",
  });

  const acceptedSend = JSON.parse(
    run(
      "parse-send-result.mjs",
      JSON.stringify({
        success: true,
        chosenOption: "option_2",
        decisionSource: "judge",
        decisionReason: "更清晰",
        judgeModel: "mcp-sampling",
        feedbackExpected: true,
        feedbackStatus: "accepted",
      }),
    ),
  );
  assert.deepEqual(acceptedSend, {
    ok: true,
    feedbackStatus: "accepted",
    chosenOption: "option_2",
    decisionSource: "judge",
    decisionReason: "更清晰",
    judgeModel: "mcp-sampling",
    feedbackExpected: true,
  });

  writeFileSync(path.join(workDir, "send-bundle.json"), bundleRaw, "utf8");
  writeFileSync(path.join(workDir, "send-result.json"), JSON.stringify(acceptedSend), "utf8");
  const composed = run("compose-result-input.mjs", "", [
    path.join(workDir, "send-bundle.json"),
    path.join(workDir, "send-result.json"),
  ]);
  const result = JSON.parse(
    run("format-candidate-result.mjs", composed, [
      "sent",
      "ts1",
      "Alice",
      "cid1",
      "prep_pipeline",
      "1",
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.chosenOption, "option_2");
  assert.equal(result.decisionSource, "judge");
  assert.equal(result.decisionReason, "更清晰");
  assert.equal(result.judgeModel, "mcp-sampling");
  assert.equal(result.judgeAttempted, true);
  assert.equal(result.feedbackExpected, true);
  assert.equal(result.feedbackClosed, true);
  assert.equal(result.feedbackQueued, false);
  assert.equal(result.feedbackGap, false);
  assert.equal(result.learningSkipped, false);
  assert.equal(result.exchangedWechat, true);

  const noJudgeBundle = JSON.parse(run("build-send-payload.mjs", "", ["prep_pipeline", "1", "1"]));
  assert.deepEqual(noJudgeBundle.sendInput, {
    preparedReplyId: "prep_pipeline",
    skipVariantJudge: true,
  });
  assert.equal(noJudgeBundle.meta.judgeSkipped, true);
  assert.equal(noJudgeBundle.meta.decisionSource, "explicit_no_judge");
  assert.equal(noJudgeBundle.meta.fallbackReason, "operator_requested_no_judge");
  assert.equal(noJudgeBundle.meta.feedbackExpected, false);

  const noJudgeSend = JSON.parse(
    run(
      "parse-send-result.mjs",
      JSON.stringify({
        success: true,
        chosenOption: "option_1",
        decisionSource: "explicit_no_judge",
        decisionReason: "operator_requested_no_judge",
        feedbackExpected: false,
        feedbackStatus: "accepted",
      }),
    ),
  );
  const noJudgeLine = JSON.parse(
    run(
      "format-candidate-result.mjs",
      JSON.stringify({ bundle: noJudgeBundle, send: noJudgeSend }),
      ["sent", "ts2", "Bob", "cid2", "prep_pipeline", "0"],
    ),
  );
  assert.equal(noJudgeLine.feedbackClosed, true);
  assert.equal(noJudgeLine.feedbackQueued, false);
  assert.equal(noJudgeLine.feedbackGap, false);
  assert.equal(noJudgeLine.learningSkipped, true);
  assert.equal(noJudgeLine.decisionSource, "explicit_no_judge");
  assert.equal(noJudgeLine.chosenOption, "option_1");

  const failedNoJudgeLine = JSON.parse(
    run(
      "format-candidate-result.mjs",
      JSON.stringify({ bundle: noJudgeBundle, send: { ok: false } }),
      ["send_failed", "ts2b", "Bob", "cid2", "prep_pipeline", "0"],
    ),
  );
  assert.equal(failedNoJudgeLine.feedbackGap, false);
  assert.equal(failedNoJudgeLine.learningSkipped, false);

  const fallbackSend = JSON.parse(
    run(
      "parse-send-result.mjs",
      JSON.stringify({
        success: true,
        chosenOption: "option_1",
        decisionSource: "service_recommended_fallback",
        decisionReason: "judge_sampling_failed",
        feedbackExpected: false,
        feedbackStatus: "accepted",
      }),
    ),
  );
  const fallbackLine = JSON.parse(
    run("format-candidate-result.mjs", JSON.stringify({ bundle, send: fallbackSend }), [
      "sent",
      "ts3",
      "Carol",
      "cid3",
      "prep_pipeline",
      "0",
    ]),
  );
  assert.equal(fallbackLine.judgeAttempted, true);
  assert.equal(fallbackLine.judgeFallback, true);
  assert.equal(fallbackLine.feedbackClosed, true);
  assert.equal(fallbackLine.feedbackGap, false);
  assert.equal(fallbackLine.learningSkipped, true);
  assert.equal(fallbackLine.fallbackReason, "judge_sampling_failed");

  const failedFallbackLine = JSON.parse(
    run(
      "format-candidate-result.mjs",
      JSON.stringify({
        bundle,
        send: {
          ...fallbackSend,
          feedbackStatus: "failed",
          feedbackError: "reply feedback rejected",
        },
      }),
      ["sent", "ts3b", "Carol", "cid3", "prep_pipeline", "0"],
    ),
  );
  assert.equal(failedFallbackLine.feedbackClosed, false);
  assert.equal(failedFallbackLine.feedbackQueued, false);
  assert.equal(failedFallbackLine.feedbackGap, true);
  assert.equal(failedFallbackLine.learningSkipped, true);

  const queuedSend = JSON.parse(
    run(
      "parse-send-result.mjs",
      JSON.stringify({
        success: true,
        chosenOption: "option_2",
        decisionSource: "judge",
        decisionReason: "更清晰",
        feedbackExpected: true,
        feedbackStatus: "queued",
      }),
    ),
  );
  const queuedLine = JSON.parse(
    run("format-candidate-result.mjs", JSON.stringify({ bundle, send: queuedSend }), [
      "sent",
      "ts4",
      "Dana",
      "cid4",
      "prep_pipeline",
      "0",
    ]),
  );
  assert.equal(queuedLine.feedbackClosed, false);
  assert.equal(queuedLine.feedbackQueued, true);
  assert.equal(queuedLine.feedbackGap, false);
  assert.equal(queuedLine.learningSkipped, false);

  const duplicateLine = JSON.parse(
    run(
      "format-candidate-result.mjs",
      JSON.stringify({
        bundle,
        send: { ...acceptedSend, feedbackStatus: "duplicate" },
      }),
      ["sent", "ts5", "Eve", "cid5", "prep_pipeline", "0"],
    ),
  );
  assert.equal(duplicateLine.feedbackClosed, true);
  assert.equal(duplicateLine.feedbackGap, false);

  const failedFeedbackLine = JSON.parse(
    run(
      "format-candidate-result.mjs",
      JSON.stringify({
        bundle,
        send: {
          ...acceptedSend,
          feedbackStatus: "failed",
          feedbackError: "network",
        },
      }),
      ["sent", "ts6", "Frank", "cid6", "prep_pipeline", "0"],
    ),
  );
  assert.equal(failedFeedbackLine.feedbackClosed, false);
  assert.equal(failedFeedbackLine.feedbackQueued, false);
  assert.equal(failedFeedbackLine.feedbackGap, true);
  assert.equal(failedFeedbackLine.learningSkipped, false);

  const missingFeedbackLine = JSON.parse(
    run(
      "format-candidate-result.mjs",
      JSON.stringify({
        bundle,
        send: {
          ok: true,
          chosenOption: "option_2",
          decisionSource: "judge",
          decisionReason: "更清晰",
          feedbackExpected: true,
        },
      }),
      ["sent", "ts7", "Grace", "cid7", "prep_pipeline", "0"],
    ),
  );
  assert.equal(missingFeedbackLine.feedbackStatus, "missing");
  assert.equal(missingFeedbackLine.feedbackClosed, false);
  assert.equal(missingFeedbackLine.feedbackGap, true);

  const unknownFeedbackStatus = runResult(
    "parse-send-result.mjs",
    JSON.stringify({ success: true, feedbackStatus: "pending" }),
  );
  assert.equal(unknownFeedbackStatus.status, 2, "unknown feedback status must be rejected");

  const invalidSource = runResult(
    "parse-send-result.mjs",
    JSON.stringify({ success: true, decisionSource: "untrusted" }),
  );
  assert.equal(invalidSource.status, 2, "unknown decision source must be rejected");

  console.log("pipeline-judge-send.test.mjs: ok");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
