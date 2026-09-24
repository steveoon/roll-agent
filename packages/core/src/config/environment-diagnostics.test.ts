import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectEnvironmentDiagnostics } from "./environment-diagnostics.ts";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "roll-env-diagnostics-"));
  const configPath = join(cwd, "roll.config.yaml");
  const secretsPath = join(cwd, "secrets.env");
  writeFileSync(
    configPath,
    `llm:\n  default-provider: custom\n  providers:\n    custom:\n      api-key: \${ROLL_DIAG_KEY}\n    unused:\n      api-key: \${OTHER_KEY}\nagents:\n  env:\n    demo:\n      REQUIRED: \${AGENT_KEY}\n`,
  );
  return { cwd, configPath, secretsPath };
}

test("service environment is explicit: shell-only values cannot make the service ready", () => {
  const f = fixture();
  try {
    const shell = inspectEnvironmentDiagnostics({
      ...f,
      environment: "service",
      env: { ROLL_DIAG_KEY: "do-not-return-this" },
    });
    assert.equal(shell.blocking, false);
    const service = inspectEnvironmentDiagnostics({
      ...f,
      environment: "estimated-service",
      env: {},
    });
    assert.equal(service.blocking, true);
    assert.ok(service.issues.some((i) => i.variable === "ROLL_DIAG_KEY" && i.severity === "error"));
    assert.ok(service.issues.some((i) => i.variable === "AGENT_KEY" && i.severity === "warning"));
    assert.ok(service.issues.some((i) => i.variable === "OTHER_KEY" && i.severity === "warning"));
    assert.doesNotMatch(JSON.stringify(shell), /do-not-return-this/);
    writeFileSync(f.secretsPath, "ROLL_DIAG_KEY=from-file\n");
    const repaired = inspectEnvironmentDiagnostics({ ...f, environment: "service", env: {} });
    assert.equal(repaired.blocking, false);
    assert.equal(
      repaired.issues.some((i) => i.variable === "ROLL_DIAG_KEY"),
      false,
    );
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("unresolved selected process value does not silently fall back; empty values do", () => {
  const f = fixture();
  try {
    writeFileSync(f.secretsPath, "ROLL_DIAG_KEY=valid-secret\n");
    assert.equal(
      inspectEnvironmentDiagnostics({
        ...f,
        environment: "service",
        env: { ROLL_DIAG_KEY: `\${NESTED}` },
      }).blocking,
      true,
    );
    assert.equal(
      inspectEnvironmentDiagnostics({ ...f, environment: "service", env: { ROLL_DIAG_KEY: "" } })
        .blocking,
      false,
    );
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("unreadable secrets and invalid config report categories without raw error text", () => {
  const f = fixture();
  try {
    mkdirSync(f.secretsPath);
    const report = inspectEnvironmentDiagnostics({ ...f, environment: "service", env: {} });
    assert.ok(report.issues.some((i) => i.code === "secrets-unreadable"));
    writeFileSync(f.configPath, "llm: [secret-do-not-leak\n");
    const invalid = inspectEnvironmentDiagnostics({ ...f, environment: "service", env: {} });
    assert.equal(invalid.blocking, true);
    assert.ok(invalid.issues.some((i) => i.code === "config-invalid"));
    assert.doesNotMatch(JSON.stringify(invalid), /secret-do-not-leak/);
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("UTF-8 diagnostics stay inside the IPC budget and keep blocking issues first", () => {
  const f = fixture();
  try {
    const providers = Array.from(
      { length: 160 },
      (_, index) =>
        `    ${"候选".repeat(50)}${index}:\n      api-key: \u0024{MISSING_${Math.floor(index / 8)}}`,
    ).join("\n");
    writeFileSync(
      f.configPath,
      `llm:\n  default-provider: selected\n  providers:\n${providers}\n    selected:\n      api-key: \u0024{SELECTED_KEY}\n`,
    );
    const result = inspectEnvironmentDiagnostics({ ...f, environment: "service", env: {} });
    assert.equal(result.blocking, true);
    assert.equal(result.issues[0]?.variable, "SELECTED_KEY");
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("runtime-selected provider determines blocking and agent-only issues stay warnings", () => {
  const f = fixture();
  try {
    writeFileSync(
      f.configPath,
      `llm:\n  default-provider: unused\n  providers:\n    unused:\n      api-key: \${UNUSED_KEY}\n    selected:\n      api-key: present\nruntime:\n  provider: selected\nagents:\n  env:\n    demo:\n      TOKEN: \${AGENT_KEY}\n`,
    );
    const result = inspectEnvironmentDiagnostics({ ...f, environment: "service", env: {} });
    assert.equal(result.blocking, false);
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues.every((i) => i.severity === "warning"));
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("selected provider URL references block, without including similarly named providers", () => {
  const f = fixture();
  try {
    for (const urlField of ["base-url", "baseUrl"]) {
      writeFileSync(
        f.configPath,
        JSON.stringify({
          llm: {
            "default-provider": "unused",
            providers: {
              custom: { "api-key": "synthetic", [urlField]: `\${CUSTOM_BASE_URL}` },
              "custom.extra": { "api-key": `\${OTHER_KEY}`, "base-url": `\${OTHER_URL}` },
            },
          },
          runtime: { provider: "custom" },
        }),
      );
      const missing = inspectEnvironmentDiagnostics({ ...f, environment: "service", env: {} });
      assert.equal(missing.blocking, true);
      assert.equal(missing.issues.find((i) => i.variable === "CUSTOM_BASE_URL")?.severity, "error");
      assert.ok(
        missing.issues
          .filter((i) => i.variable !== "CUSTOM_BASE_URL")
          .every((i) => i.severity === "warning"),
      );
      const fixed = inspectEnvironmentDiagnostics({
        ...f,
        environment: "service",
        env: { CUSTOM_BASE_URL: "https://example.invalid/v1" },
      });
      assert.equal(fixed.blocking, false);
      assert.equal(
        fixed.issues.some((i) => i.variable === "CUSTOM_BASE_URL"),
        false,
      );
    }
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});
