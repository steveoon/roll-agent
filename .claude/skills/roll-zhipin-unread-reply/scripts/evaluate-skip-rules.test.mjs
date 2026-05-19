#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = join(dirname(fileURLToPath(import.meta.url)), "evaluate-skip-rules.mjs");

function run(input) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

assert.equal(run({ preview: "我加您了", candidateInfo: {}, chatMessages: [] }).skip, true);
assert.equal(
  run({ preview: "hello", candidateInfo: { age: "20岁", experience: "工作26年" }, chatMessages: [] }).reason,
  "student_age_experience_year",
);
assert.equal(
  run({
    preview: "",
    pageUrl: "https://www.zhipin.com/web/passport/zp/verify.html",
    candidateInfo: {},
    chatMessages: [],
  }).stop,
  true,
);
assert.equal(run({ preview: "ok", candidateInfo: {}, chatMessages: [] }).skip, false);

console.log("evaluate-skip-rules.test.mjs: ok");
