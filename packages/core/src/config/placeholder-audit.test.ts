import test from "node:test";
import assert from "node:assert/strict";
import { auditPlaceholderResolution, collectConfigPlaceholders } from "./placeholder-audit.ts";

const sample = {
  llm: { providers: { qwen: { "api-key": "${DASHSCOPE_API_KEY}" } } },
  agents: { env: { "smart-reply-agent": { TOKEN: "${REPLY_TOKEN}" } } },
  registry: "${ROLL_REGISTRY}",
  plain: "no-placeholder",
};

test("collectConfigPlaceholders lists every placeholder with its config path", () => {
  const found = collectConfigPlaceholders(sample);
  assert.deepEqual(
    found.map((p) => p.name).sort(),
    ["DASHSCOPE_API_KEY", "REPLY_TOKEN", "ROLL_REGISTRY"],
  );
  const registry = found.find((p) => p.name === "ROLL_REGISTRY");
  assert.deepEqual(registry?.paths, ["registry"]);
});

test("auditPlaceholderResolution resolves from secretsEnv when process env lacks the var", () => {
  const report = auditPlaceholderResolution(sample, {
    processEnv: { DASHSCOPE_API_KEY: "set" },
    secretsEnv: { REPLY_TOKEN: "secret" },
  });
  assert.deepEqual(report.unresolved.map((p) => p.name), ["ROLL_REGISTRY"]);
});

test("empty-string env values count as unset", () => {
  const report = auditPlaceholderResolution({ key: "${X}" }, { processEnv: { X: "" } });
  assert.deepEqual(report.unresolved.map((p) => p.name), ["X"]);
});

test("extraEnv participates in resolution", () => {
  const report = auditPlaceholderResolution(
    { key: "${PLIST_VAR}" },
    { processEnv: {}, extraEnv: { PLIST_VAR: "from-plist" } },
  );
  assert.deepEqual(report.unresolved, []);
});
