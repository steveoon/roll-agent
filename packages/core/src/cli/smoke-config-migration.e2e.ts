import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  runRoll,
  buildConfigYaml,
  buildDeprecatedConfigYaml,
  createFakeNpm,
  createDeclaredEnvFixtureAgent,
} from "./smoke.e2e-harness.ts";

test("e2e smoke: config set help clarifies dotted key syntax", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-help-${randomUUID()}-`));

  try {
    const result = runRoll(["config", "set", "--help"], workspace);
    assert.equal(
      result.status,
      0,
      `config set --help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /英文句点 [`]?\.[`]? 分隔/);
    assert.match(result.stdout, /ask\.confirm-threshold/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config explain describes install registry", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-explain-${randomUUID()}-`));

  try {
    const result = runRoll(["config", "explain", "install.registry"], workspace);
    assert.equal(
      result.status,
      0,
      `config explain failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /npm Registry/);
    assert.match(result.stdout, /显式|默认源|registry/);
    assert.match(result.stdout, /roll config setup install/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config setup fails clearly without a TTY", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-setup-tty-${randomUUID()}-`));

  try {
    const result = runRoll(["config", "setup", "llm"], workspace);
    assert.equal(
      result.status,
      1,
      `expected non-zero exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /需要交互式终端/);
    assert.match(result.stderr, /roll config set/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config init writes ask section and ask config can be set/get", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-${randomUUID()}-`));
  const homeEnv = { HOME: workspace };

  try {
    const initResult = runRoll(["config", "init"], workspace, { input: "\n\n\n", env: homeEnv });
    assert.equal(
      initResult.status,
      0,
      `config init failed\nstdout:\n${initResult.stdout}\nstderr:\n${initResult.stderr}`,
    );

    const configPath = resolve(workspace, "roll.config.yaml");
    const configText = readFileSync(configPath, "utf-8");
    assert.match(configText, /^ask:/m);
    assert.ok(!configText.includes("router:"));

    const setModelResult = runRoll(["config", "set", "ask.llmModel", "gpt-4.1-mini"], workspace, {
      env: homeEnv,
    });
    assert.equal(
      setModelResult.status,
      0,
      `config set ask.llmModel failed\nstdout:\n${setModelResult.stdout}\nstderr:\n${setModelResult.stderr}`,
    );

    const getModelResult = runRoll(["config", "get", "ask.llmModel"], workspace, { env: homeEnv });
    assert.equal(getModelResult.status, 0, getModelResult.stderr);
    assert.equal(getModelResult.stdout.trim(), "gpt-4.1-mini");

    const setThresholdResult = runRoll(
      ["config", "set", "ask.confirmThreshold", "0.7"],
      workspace,
      { env: homeEnv },
    );
    assert.equal(setThresholdResult.status, 0, setThresholdResult.stderr);

    const getThresholdResult = runRoll(["config", "get", "ask.confirmThreshold"], workspace, {
      env: homeEnv,
    });
    assert.equal(getThresholdResult.status, 0, getThresholdResult.stderr);
    assert.equal(getThresholdResult.stdout.trim(), "0.7");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config get accepts kebab and camel paths equivalently", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-get-codec-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers:
    anthropic:
      api-key: sk-test
      base-url: https://example.com
agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const kebabResult = runRoll(["config", "get", "llm.default-provider"], workspace);
    assert.equal(kebabResult.status, 0, kebabResult.stderr);
    assert.equal(kebabResult.stdout.trim(), "anthropic");

    const camelResult = runRoll(["config", "get", "llm.defaultProvider"], workspace);
    assert.equal(camelResult.status, 0, camelResult.stderr);
    assert.equal(camelResult.stdout.trim(), "anthropic");

    const nestedKebabResult = runRoll(
      ["config", "get", "llm.providers.anthropic.base-url"],
      workspace,
    );
    assert.equal(nestedKebabResult.status, 0, nestedKebabResult.stderr);
    assert.equal(nestedKebabResult.stdout.trim(), "https://example.com");

    const nestedCamelResult = runRoll(
      ["config", "get", "llm.providers.anthropic.baseUrl"],
      workspace,
    );
    assert.equal(nestedCamelResult.status, 0, nestedCamelResult.stderr);
    assert.equal(nestedCamelResult.stdout.trim(), "https://example.com");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent list blocks legacy camelCase agents.env keys with migration guidance", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-legacy-agents-env-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}
agents:
  data-dir: ${resolve(workspace, "agents-data")}
  env:
    smartReplyAgent:
      REPLY_AUTHORITY_URL: https://legacy.example.com
`,
      "utf-8",
    );

    const result = runRoll(["agent", "list"], workspace);
    assert.equal(result.status, 1, `agent list should fail\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /smartReplyAgent/);
    assert.match(result.stderr, /roll config migrate/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: deprecated router config fails with migration guidance", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-router-migration-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["config", "get"], workspace);
    assert.equal(result.status, 1, `config get should fail\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /`router` 配置段已废弃/);
    assert.match(result.stderr, /ask\.llm-model/);
    assert.match(result.stderr, /ask\.confirm-threshold/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: deprecated runtime.bash config fails with migration guidance", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-runtime-shell-migration-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

runtime:
  bash:
    enabled: true
    auto-approve-safe: false

agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const result = runRoll(["config", "get"], workspace);
    assert.equal(result.status, 1, `config get should fail\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /`runtime\.bash` 配置段已废弃/);
    assert.match(result.stderr, /runtime\.shell/);
    assert.match(result.stderr, /roll config migrate/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config migrate rewrites router config and creates backup", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-migrate-${randomUUID()}-`));

  try {
    const configPath = resolve(workspace, "roll.config.yaml");
    writeFileSync(
      configPath,
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const migrateResult = runRoll(["config", "migrate"], workspace);
    assert.equal(
      migrateResult.status,
      0,
      `config migrate failed\nstdout:\n${migrateResult.stdout}\nstderr:\n${migrateResult.stderr}`,
    );
    assert.match(migrateResult.stdout, /配置文件已迁移/);
    assert.match(migrateResult.stdout, /已备份原文件/);

    const migratedConfig = readFileSync(configPath, "utf-8");
    assert.match(migratedConfig, /^ask:/m);
    assert.ok(!migratedConfig.includes("router:"));

    const backupPath = migrateResult.stdout
      .split(/\r?\n/u)
      .find((line) => line.includes("已备份原文件: "))
      ?.split("已备份原文件: ", 2)[1]
      ?.trim();
    assert.ok(backupPath);
    assert.equal(existsSync(backupPath), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config migrate rewrites runtime.bash to runtime.shell", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-runtime-shell-migrate-${randomUUID()}-`));

  try {
    const configPath = resolve(workspace, "roll.config.yaml");
    writeFileSync(
      configPath,
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

runtime:
  bash:
    enabled: true
    auto-approve-safe: false
    session:
      enabled: true

agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const migrateResult = runRoll(["config", "migrate"], workspace);
    assert.equal(
      migrateResult.status,
      0,
      `config migrate failed\nstdout:\n${migrateResult.stdout}\nstderr:\n${migrateResult.stderr}`,
    );
    assert.match(migrateResult.stdout, /runtime\.bash/);
    assert.match(migrateResult.stdout, /runtime\.shell/);

    const migratedConfig = readFileSync(configPath, "utf-8");
    assert.match(migratedConfig, /^runtime:/m);
    assert.match(migratedConfig, /shell:/);
    assert.match(migratedConfig, /auto-approve-safe: false/);
    assert.match(migratedConfig, /session:\n\s+enabled: true/);
    assert.ok(!migratedConfig.includes("bash:"));

    const getResult = runRoll(["config", "get", "runtime.shell.enabled"], workspace);
    assert.equal(getResult.status, 0, getResult.stderr);
    assert.match(getResult.stdout, /true/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config migrate fails when router and ask values conflict", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-conflict-${randomUUID()}-`));

  try {
    const configPath = resolve(workspace, "roll.config.yaml");
    writeFileSync(
      configPath,
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  llm-model: gpt-4.1-mini

router:
  llm-model: claude-sonnet-4-6

agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const original = readFileSync(configPath, "utf-8");
    const migrateResult = runRoll(["config", "migrate"], workspace);
    assert.equal(migrateResult.status, 1, migrateResult.stdout);
    assert.match(migrateResult.stderr, /值冲突/);
    assert.equal(readFileSync(configPath, "utf-8"), original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent list still works with deprecated router config", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-agent-list-router-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(dataDir),
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", smokeAgentPath], workspace, {
      env: { ROLL_SKIP_INSTALL: "1" },
    });
    assert.equal(
      addResult.status,
      0,
      `agent add with deprecated router config failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
    );

    const listResult = runRoll(["agent", "list", "--json"], workspace);
    assert.equal(
      listResult.status,
      0,
      `agent list with deprecated router config failed\nstdout:\n${listResult.stdout}\nstderr:\n${listResult.stderr}`,
    );

    const listedAgents = JSON.parse(listResult.stdout) as ReadonlyArray<{
      readonly skill: { readonly name: string };
    }>;
    assert.ok(listedAgents.some((agent) => agent.skill.name === "smoke-test-agent"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config init suggests migrate when existing config uses deprecated router schema", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-init-router-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["config", "init"], workspace, { input: "" });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /建议先运行 `roll config migrate`/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor reports config that needs migration", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-doctor-router-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["doctor", "--json"], workspace);
    assert.equal(result.status, 0, result.stderr);

    const checks = JSON.parse(result.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;
    const configCheck = checks.find((check) => check.name === "配置文件");
    assert.ok(configCheck);
    assert.equal(configCheck.status, "warn");
    assert.match(configCheck.message, /需要迁移/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor reports invalid config file", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-doctor-invalid-${randomUUID()}-`));

  try {
    writeFileSync(resolve(workspace, "roll.config.yaml"), "llm: [\n", "utf-8");

    const result = runRoll(["doctor", "--json"], workspace);
    assert.equal(result.status, 1, result.stdout);

    const checks = JSON.parse(result.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;
    const configCheck = checks.find((check) => check.name === "配置文件");
    assert.ok(configCheck);
    assert.equal(configCheck.status, "fail");
    assert.match(configCheck.message, /Invalid YAML syntax/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor reports agent env issues from declared requirements", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-doctor-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", agentDir], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
    assert.equal(addResult.status, 0, addResult.stderr);

    const doctorResult = runRoll(["doctor", "--json"], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
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

test("e2e smoke: update --check warns about deprecated config without failing", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-check-router-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, "0.2.1");
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["update", "--check"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stderr, /检测到本地配置需要迁移/);
    assert.match(result.stderr, /roll config migrate/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
