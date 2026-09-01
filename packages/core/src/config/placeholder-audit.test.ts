import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditPlaceholderResolution,
  auditScheduledServicePlaceholders,
  buildScheduledServiceBaselineEnv,
  collectConfigPlaceholders,
} from "./placeholder-audit.ts";

const sample = {
  llm: { providers: { qwen: { "api-key": `\${DASHSCOPE_API_KEY}` } } },
  agents: { env: { "smart-reply-agent": { TOKEN: `\${REPLY_TOKEN}` } } },
  registry: `\${ROLL_REGISTRY}`,
  plain: "no-placeholder",
};

test("collectConfigPlaceholders lists every placeholder with its config path", () => {
  const found = collectConfigPlaceholders(sample);
  assert.deepEqual(found.map((p) => p.name).sort(), [
    "DASHSCOPE_API_KEY",
    "REPLY_TOKEN",
    "ROLL_REGISTRY",
  ]);
  const registry = found.find((p) => p.name === "ROLL_REGISTRY");
  assert.deepEqual(registry?.paths, ["registry"]);
});

test("auditPlaceholderResolution resolves from secretsEnv when process env lacks the var", () => {
  const report = auditPlaceholderResolution(sample, {
    processEnv: { DASHSCOPE_API_KEY: "set" },
    secretsEnv: { REPLY_TOKEN: "secret" },
  });
  assert.deepEqual(
    report.unresolved.map((p) => p.name),
    ["ROLL_REGISTRY"],
  );
});

test("empty-string env values count as unset", () => {
  const report = auditPlaceholderResolution({ key: `\${X}` }, { processEnv: { X: "" } });
  assert.deepEqual(
    report.unresolved.map((p) => p.name),
    ["X"],
  );
});

test("the first non-empty env value remains unresolved when it still contains a placeholder", () => {
  const fromSecrets = auditPlaceholderResolution(
    { key: `\${PRIMARY_KEY}` },
    { processEnv: {}, secretsEnv: { PRIMARY_KEY: `\${SECONDARY_KEY}` } },
  );
  assert.deepEqual(
    fromSecrets.unresolved.map((p) => p.name),
    ["PRIMARY_KEY"],
  );

  const processEnvWins = auditPlaceholderResolution(
    { key: `\${PRIMARY_KEY}` },
    {
      processEnv: { PRIMARY_KEY: `\${SECONDARY_KEY}` },
      secretsEnv: { PRIMARY_KEY: "usable-secret" },
    },
  );
  assert.deepEqual(
    processEnvWins.unresolved.map((p) => p.name),
    ["PRIMARY_KEY"],
  );
});

test("extraEnv participates in resolution", () => {
  const report = auditPlaceholderResolution(
    { key: `\${PLIST_VAR}` },
    { processEnv: {}, extraEnv: { PLIST_VAR: "from-plist" } },
  );
  assert.deepEqual(report.unresolved, []);
});

test("buildScheduledServiceBaselineEnv keeps only baseline keys", () => {
  const baseline: Record<string, string> = buildScheduledServiceBaselineEnv({
    HOME: "/home/u",
    PATH: "/usr/bin",
    DASHSCOPE_API_KEY: "user-shell-key",
    USER: "tester",
  });
  assert.deepEqual(baseline, { HOME: "/home/u", PATH: "/usr/bin", USER: "tester" });
  assert.equal(Object.hasOwn(baseline, "DASHSCOPE_API_KEY"), false);
});

test("auditScheduledServicePlaceholders audits a config file against the scheduled-service env", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-audit-"));
  const configPath = join(dir, "roll.config.yaml");
  writeFileSync(
    configPath,
    ["llm:", "  providers:", "    qwen:", `      api-key: \${AUDIT_PROBE_KEY}`, ""].join("\n"),
  );
  const secretsPath = join(dir, "secrets.env");
  const missing = auditScheduledServicePlaceholders({
    loadOptions: { configPath },
    secretsPath,
  });
  assert.deepEqual(
    missing?.unresolved.map((p) => p.name),
    ["AUDIT_PROBE_KEY"],
  );
  assert.equal(missing?.placeholderTotal, 1);
  assert.equal(missing?.secretsReadable, true);

  writeFileSync(secretsPath, "AUDIT_PROBE_KEY=from-secrets\n");
  const resolved = auditScheduledServicePlaceholders({
    loadOptions: { configPath },
    secretsPath,
  });
  assert.deepEqual(resolved?.unresolved, []);
  assert.equal(resolved === undefined ? undefined : "secretsVariables" in resolved, false);
});

test("auditScheduledServicePlaceholders returns undefined when no config is found", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-audit-"));
  const result = auditScheduledServicePlaceholders({
    loadOptions: { configPath: join(dir, "roll.config.yaml") },
    secretsPath: join(dir, "secrets.env"),
  });
  assert.equal(result, undefined);
});
