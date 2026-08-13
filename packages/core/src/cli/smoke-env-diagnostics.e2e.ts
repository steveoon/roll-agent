import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  runRoll,
  buildConfigYaml,
  createDeclaredEnvFixtureAgent,
  createDiagnosticEnvFixtureAgent,
  createPreflightFixtureAgent,
} from "./smoke.e2e-harness.ts";

test("e2e smoke: agent add warns when declared required env is missing", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-add-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);
    assert.match(addResult.stderr, /仍缺少必填环境变量: REQUIRED_TOKEN, REQUIRED_URL/);
    assert.match(addResult.stderr, /roll config setup agent declared-env-agent/);
    assert.match(addResult.stderr, /roll config explain agents\.env\.declared-env-agent/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent info shows declared env satisfaction sources", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-info-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    declared-env-agent:
      REQUIRED_TOKEN: config-token
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
    assert.equal(addResult.status, 0, addResult.stderr);

    const infoResult = runRoll(["agent", "info", "declared-env-agent"], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
    assert.equal(infoResult.status, 0, infoResult.stderr);
    assert.match(infoResult.stdout, /REQUIRED_TOKEN: \[必填\] 已配置于 agents\.env/);
    assert.match(infoResult.stdout, /REQUIRED_URL: \[必填\] 仅当前 shell 环境/);
    assert.match(infoResult.stdout, /OPTIONAL_MODEL: \[可选\] 默认值 \(provider\/default-model\)/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: unresolved agents.env placeholders are treated as missing", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-placeholder-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    declared-env-agent:
      REQUIRED_TOKEN: \${ROLL_MISSING_REQUIRED_TOKEN}
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);
    assert.match(addResult.stderr, /仍缺少必填环境变量: REQUIRED_TOKEN, REQUIRED_URL/);
    assert.match(addResult.stderr, /roll config setup agent declared-env-agent/);

    const infoResult = runRoll(["agent", "info", "declared-env-agent"], workspace);
    assert.equal(infoResult.status, 0, infoResult.stderr);
    assert.match(infoResult.stdout, /REQUIRED_TOKEN: \[必填\] 缺失/);

    const doctorResult = runRoll(["doctor", "--json"], workspace);
    assert.equal(doctorResult.status, 1, doctorResult.stderr);

    const checks = JSON.parse(doctorResult.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;

    const envCheck = checks.find((check) => check.name === "Agent 环境变量 (declared-env-agent)");
    assert.ok(envCheck);
    assert.equal(envCheck.status, "fail");
    assert.match(envCheck.message, /REQUIRED_TOKEN/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent info compares declared env with runtime diagnostics", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-diagnostic-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "diagnostic-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDiagnosticEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    diagnostic-env-agent:
      CONFIG_TOKEN: config-token
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);

    const infoResult = runRoll(["agent", "info", "diagnostic-env-agent"], workspace, {
      env: { SHELL_ONLY_TOKEN: "shell-token" },
    });
    assert.equal(infoResult.status, 0, infoResult.stderr);
    assert.match(infoResult.stdout, /运行态校验: 已验证（diagnostic_status）/);
    assert.match(
      infoResult.stdout,
      /CONFIG_TOKEN: \[必填\] 已配置于 agents\.env；运行态: ✓ from yaml \(stable\)/,
    );
    assert.match(
      infoResult.stdout,
      /SHELL_ONLY_TOKEN: \[必填\] 仅当前 shell 环境；运行态: ⚠ from shell \(ephemeral\)/,
    );
    assert.match(
      infoResult.stdout,
      /OPTIONAL_MODEL: \[可选\] 默认值 \(provider\/default-model\)；运行态: 未设置（使用默认值）/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor surfaces runtime env drift as warn", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-diagnostic-doctor-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "diagnostic-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDiagnosticEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    diagnostic-env-agent:
      CONFIG_TOKEN: config-token
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);

    const doctorResult = runRoll(["doctor", "--json"], workspace, {
      env: { SHELL_ONLY_TOKEN: "shell-token" },
    });
    assert.equal(doctorResult.status, 0, doctorResult.stderr);

    const checks = JSON.parse(doctorResult.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;

    const envCheck = checks.find((check) => check.name === "Agent 环境变量 (diagnostic-env-agent)");
    assert.ok(envCheck);
    assert.equal(envCheck.status, "warn");
    assert.match(envCheck.message, /SHELL_ONLY_TOKEN/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll run aggregates missing input fields and env requirements", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-preflight-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "preflight-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    createPreflightFixtureAgent(agentDir);
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);

    const runResult = runRoll(
      ["run", "preflight-fixture-agent", "generate_reply", "--input-json", "{}"],
      workspace,
    );
    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /A\. 输入缺失 \/ 参数校验/);
    assert.match(runResult.stderr, /field 为必填字段/);
    assert.match(runResult.stderr, /target\.platform 为必填字段/);
    assert.match(runResult.stderr, /target\.recruiterUsername 为必填字段/);
    assert.match(runResult.stderr, /B\. 运行条件缺失/);
    assert.match(runResult.stderr, /REQUIRED_TOKEN/);
    assert.match(runResult.stderr, /agents\.env\.preflight-fixture-agent/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
