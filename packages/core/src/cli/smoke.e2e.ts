import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunRollOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

function runRoll(
  args: readonly string[],
  cwd: string,
  options: RunRollOptions = {},
): CliResult {
  const cliEntry = resolve(import.meta.dirname, "index.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
    input: options.input,
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function buildConfigYaml(dataDir: string): string {
  return `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-20250514
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
`;
}

function buildDeprecatedConfigYaml(dataDir: string): string {
  return `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-20250514
  providers: {}

router:
  mode: declarative
  llm-model: claude-sonnet-4-20250514

agents:
  data-dir: ${dataDir}
`;
}

test("e2e smoke: register fixture agent and run ping", { timeout: 120_000 }, () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-e2e-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", smokeAgentPath], workspace, {
      env: { ROLL_SKIP_INSTALL: "1" },
    });
    assert.equal(
      addResult.status,
      0,
      `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
    );

    const listResult = runRoll(["agent", "list", "--json"], workspace);
    assert.equal(
      listResult.status,
      0,
      `agent list failed\nstdout:\n${listResult.stdout}\nstderr:\n${listResult.stderr}`,
    );

    const listedAgents = JSON.parse(listResult.stdout) as ReadonlyArray<{
      readonly skill: { readonly name: string };
    }>;
    assert.ok(listedAgents.some((agent) => agent.skill.name === "smoke-test-agent"));

    const runResult = runRoll(["run", "smoke-test-agent", "ping"], workspace);
    assert.equal(
      runResult.status,
      0,
      `roll run failed\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`,
    );
    assert.match(runResult.stdout, /"messages"\s*:\s*\[\]/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll --help includes chat", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-help-${randomUUID()}-`));

  try {
    const result = runRoll(["--help"], workspace);
    assert.equal(result.status, 0, `roll --help failed\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /\bchat\b/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll chat --help marks command experimental", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-chat-help-${randomUUID()}-`));

  try {
    const result = runRoll(["chat", "--help"], workspace);
    assert.equal(result.status, 0, `roll chat --help failed\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Experimental/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll chat --json returns unavailable snapshot", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-chat-json-${randomUUID()}-`));

  try {
    const result = runRoll(["chat", "--json"], workspace);
    assert.equal(
      result.status,
      1,
      `roll chat --json should fail while experimental\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const parsed = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly message: string;
    };
    assert.equal(parsed.status, "unavailable");
    assert.match(parsed.message, /experimental/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config init writes ask section and ask config can be set/get", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-${randomUUID()}-`));

  try {
    const initResult = runRoll(["config", "init"], workspace, { input: "\n\n\n" });
    assert.equal(
      initResult.status,
      0,
      `config init failed\nstdout:\n${initResult.stdout}\nstderr:\n${initResult.stderr}`,
    );

    const configPath = resolve(workspace, "roll.config.yaml");
    const configText = readFileSync(configPath, "utf-8");
    assert.match(configText, /^ask:/m);
    assert.ok(!configText.includes("router:"));

    const setModelResult = runRoll(["config", "set", "ask.llmModel", "gpt-4.1-mini"], workspace);
    assert.equal(
      setModelResult.status,
      0,
      `config set ask.llmModel failed\nstdout:\n${setModelResult.stdout}\nstderr:\n${setModelResult.stderr}`,
    );

    const getModelResult = runRoll(["config", "get", "ask.llmModel"], workspace);
    assert.equal(getModelResult.status, 0, getModelResult.stderr);
    assert.equal(getModelResult.stdout.trim(), "gpt-4.1-mini");

    const setThresholdResult = runRoll(
      ["config", "set", "ask.confirmThreshold", "0.7"],
      workspace,
    );
    assert.equal(setThresholdResult.status, 0, setThresholdResult.stderr);

    const getThresholdResult = runRoll(["config", "get", "ask.confirmThreshold"], workspace);
    assert.equal(getThresholdResult.status, 0, getThresholdResult.stderr);
    assert.equal(getThresholdResult.stdout.trim(), "0.7");
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
