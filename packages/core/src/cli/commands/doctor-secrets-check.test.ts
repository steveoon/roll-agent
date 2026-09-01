import test from "node:test";
import assert from "node:assert/strict";
import { formatSecretsAndPlaceholderCheck } from "./doctor.ts";

test("warns when placeholders are unresolved for scheduled services", () => {
  const result = formatSecretsAndPlaceholderCheck({
    secretsPath: "/home/u/.roll-agent/secrets.env",
    secretsExists: false,
    secretsIsPrivate: undefined,
    secretsVariableCount: 0,
    unresolved: [{ name: "DASHSCOPE_API_KEY", paths: ["llm.providers.qwen.api-key"] }],
    placeholderTotal: 1,
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /DASHSCOPE_API_KEY/);
  assert.match(result.message, /不会加载/);
  assert.doesNotMatch(result.message, /secret-value|sk-/); // 只露变量名，不露值
  assert.match(result.fix ?? "", /secrets\.env/);
});

test("warns when secrets.env exists but is world-readable", () => {
  const result = formatSecretsAndPlaceholderCheck({
    secretsPath: "/home/u/.roll-agent/secrets.env",
    secretsExists: true,
    secretsIsPrivate: false,
    secretsVariableCount: 2,
    unresolved: [],
    placeholderTotal: 2,
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /权限|600/);
});

test("ok when everything resolves and secrets.env is private", () => {
  const result = formatSecretsAndPlaceholderCheck({
    secretsPath: "/home/u/.roll-agent/secrets.env",
    secretsExists: true,
    secretsIsPrivate: true,
    secretsVariableCount: 2,
    unresolved: [],
    placeholderTotal: 2,
  });
  assert.equal(result.status, "ok");
});

test("ok when there are no placeholders at all", () => {
  const result = formatSecretsAndPlaceholderCheck({
    secretsPath: "/home/u/.roll-agent/secrets.env",
    secretsExists: false,
    secretsIsPrivate: undefined,
    secretsVariableCount: 0,
    unresolved: [],
    placeholderTotal: 0,
  });
  assert.equal(result.status, "ok");
});

test("unresolved wins over permission issue in status", () => {
  const result = formatSecretsAndPlaceholderCheck({
    secretsPath: "/home/u/.roll-agent/secrets.env",
    secretsExists: true,
    secretsIsPrivate: false,
    secretsVariableCount: 1,
    unresolved: [{ name: "X", paths: ["a.b"] }],
    placeholderTotal: 1,
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /X/);
});
