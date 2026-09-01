import test from "node:test";
import assert from "node:assert/strict";
import { formatInstallEnvPreflight } from "./schedule-service-install.ts";

test("returns undefined when nothing is unresolved", () => {
  assert.equal(formatInstallEnvPreflight({ unresolved: [] }), undefined);
});

test("lists unresolved variables with config paths and secrets.env guidance", () => {
  const text = formatInstallEnvPreflight({
    unresolved: [{ name: "DASHSCOPE_API_KEY", paths: ["llm.providers.qwen.api-key"] }],
  });
  assert.match(text ?? "", /DASHSCOPE_API_KEY/);
  assert.match(text ?? "", /llm\.providers\.qwen\.api-key/);
  assert.match(text ?? "", /secrets\.env/);
  assert.match(text ?? "", /launchd|调度服务/);
  assert.doesNotMatch(text ?? "", /sk-|secret-value/); // 只露变量名
});

test("lists multiple unresolved variables", () => {
  const text = formatInstallEnvPreflight({
    unresolved: [
      { name: "A_KEY", paths: ["x.y"] },
      { name: "B_KEY", paths: ["a.b", "a.c"] },
    ],
  });
  assert.match(text ?? "", /A_KEY/);
  assert.match(text ?? "", /B_KEY/);
  assert.match(text ?? "", /a\.b, a\.c/);
});
