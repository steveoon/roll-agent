import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const CURRENT_CORE_VERSION = readCurrentCoreVersion();
const NEXT_PATCH_CORE_VERSION = bumpPatchVersion(CURRENT_CORE_VERSION);

function runRoll(args: readonly string[], cwd: string, options: RunRollOptions = {}): CliResult {
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

function readCurrentCoreVersion(): string {
  const packageJsonPath = resolve(import.meta.dirname, "../../package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Unable to read @roll-agent/core version from ${packageJsonPath}`);
  }
  return parsed.version;
}

function bumpPatchVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) {
    throw new Error(`Unsupported semver version: ${version}`);
  }

  const [majorRaw, minorRaw, patchRaw] = parts;
  const major = Number.parseInt(majorRaw ?? "", 10);
  const minor = Number.parseInt(minorRaw ?? "", 10);
  const patch = Number.parseInt(patchRaw ?? "", 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`Unsupported semver version: ${version}`);
  }
  return `${major}.${minor}.${patch + 1}`;
}

function createFakeNpm(binDir: string, latestVersion: string): void {
  mkdirSync(binDir, { recursive: true });
  const npmPath = resolve(binDir, "npm");
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "view" && args[2] === "version") {
  const useJson = args.includes("--json");
  const output = useJson ? JSON.stringify(${JSON.stringify(latestVersion)}) : ${JSON.stringify(latestVersion)};
  process.stdout.write(output + "\\n");
  process.exit(0);
}
if (args[0] === "install" && args[1] === "-g") {
  process.exit(0);
}
process.exit(0);
`,
    "utf-8",
  );
  chmodSync(npmPath, 0o755);
}

function createCoreManagedHttpFixtureAgent(
  agentDir: string,
  port: number,
  options: {
    readonly shutdownDelayMs?: number;
    readonly createBrokenDistEntry?: boolean;
  } = {},
): void {
  const sdkEntry = resolve(import.meta.dirname, "../../../../packages/sdk/src/index.ts");
  const zodEntry = resolve(
    import.meta.dirname,
    "../../../../packages/sdk/node_modules/zod/index.js",
  );
  const shutdownDelayMs = options.shutdownDelayMs ?? 0;

  mkdirSync(resolve(agentDir, "src"), { recursive: true });

  writeFileSync(
    resolve(agentDir, "SKILL.md"),
    `---
name: http-fixture-agent
description: Core managed HTTP fixture agent
---

Provides a single ping tool for lifecycle smoke tests.
`,
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "package.json"),
    JSON.stringify(
      {
        name: "http-fixture-agent",
        version: "0.0.1",
        private: true,
        type: "module",
        rollAgent: {
          runtime: {
            ownership: "core-managed",
            transport: "streamable-http",
          },
          start: {
            command: process.execPath,
            args: ["dist/index.js"],
          },
          endpoint: {
            path: "/mcp",
            port,
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "src/index.ts"),
    `import { defineAgent, defineTool } from ${JSON.stringify(sdkEntry)};
import { z } from ${JSON.stringify(zodEntry)};

if (${shutdownDelayMs} > 0) {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      process.exit(0);
    }, ${shutdownDelayMs});
  });
}

const ping = defineTool({
  name: "ping",
  description: "health ping",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const agent = defineAgent({
  name: "http-fixture-agent",
  tools: [ping],
});

await agent.listen({
  transport: {
    type: "http",
    host: "127.0.0.1",
    port: ${port},
  },
});
`,
    "utf-8",
  );

  if (options.createBrokenDistEntry) {
    mkdirSync(resolve(agentDir, "dist"), { recursive: true });
    writeFileSync(
      resolve(agentDir, "dist/index.js"),
      'throw new Error("dist entry should not be used for local-path fixture");\n',
      "utf-8",
    );
  }
}

function createDeclaredEnvFixtureAgent(agentDir: string): void {
  mkdirSync(resolve(agentDir, "references"), { recursive: true });
  writeFileSync(
    resolve(agentDir, "SKILL.md"),
    `---
name: declared-env-agent
description: Agent with declared environment requirements
metadata:
  roll-transport: stdio
  roll-command: node src/index.ts
  roll-env-file: references/env.yaml
---
`,
    "utf-8",
  );
  writeFileSync(
    resolve(agentDir, "references/env.yaml"),
    `required:
  - name: REQUIRED_TOKEN
    purpose: Required auth token
  - name: REQUIRED_URL
    purpose: Required upstream URL
optional:
  - name: OPTIONAL_MODEL
    purpose: Optional model override
    default: provider/default-model
`,
    "utf-8",
  );
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

test("e2e smoke: agent install rejects local source directories", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-install-local-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const installResult = runRoll(["agent", "install", smokeAgentPath], workspace);
    assert.equal(installResult.status, 1);
    assert.match(installResult.stderr, /本地源码目录请使用 `roll agent add/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

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
    assert.match(addResult.stderr, /agents\.env\.declared-env-agent/);
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
  default-model: claude-sonnet-4-20250514
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
  default-model: claude-sonnet-4-20250514
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

    const setThresholdResult = runRoll(["config", "set", "ask.confirmThreshold", "0.7"], workspace);
    assert.equal(setThresholdResult.status, 0, setThresholdResult.stderr);

    const getThresholdResult = runRoll(["config", "get", "ask.confirmThreshold"], workspace);
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
  default-model: claude-sonnet-4-20250514
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
  default-model: claude-sonnet-4-20250514
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

test("e2e smoke: config migrate fails when router and ask values conflict", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-conflict-${randomUUID()}-`));

  try {
    const configPath = resolve(workspace, "roll.config.yaml");
    writeFileSync(
      configPath,
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-20250514
  providers: {}

ask:
  llm-model: gpt-4.1-mini

router:
  llm-model: claude-sonnet-4-20250514

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

test("e2e smoke: update warns after self-update when config needs migration", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-router-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, NEXT_PATCH_CORE_VERSION);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["update"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(`roll 已更新到 v${NEXT_PATCH_CORE_VERSION}`));
    assert.match(result.stderr, /升级后需要迁移本地配置/);
    assert.match(result.stderr, /roll config migrate/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update still self-updates when config YAML is invalid", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-invalid-config-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, NEXT_PATCH_CORE_VERSION);
    writeFileSync(resolve(workspace, "roll.config.yaml"), "llm: [\n", "utf-8");

    const result = runRoll(["update"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stderr, /本地配置存在问题/);
    assert.match(result.stderr, new RegExp(`roll 已更新到 v${NEXT_PATCH_CORE_VERSION}`));
    assert.match(result.stderr, /请修复配置文件后再继续使用相关命令/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent health --json returns empty array when no agents are registered", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-health-empty-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["agent", "health", "--json"], workspace);
    assert.equal(result.status, 0, `agent health --json failed\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), "[]");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test(
  "e2e smoke: core-managed http agent can start, report health, and stop",
  {
    timeout: 120_000,
  },
  () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-agent-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = 32_000 + Math.floor(Math.random() * 5_000);

      createCoreManagedHttpFixtureAgent(agentDir, port, {
        shutdownDelayMs: 1_200,
        createBrokenDistEntry: true,
      });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(
        addResult.status,
        0,
        `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
      );

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(
        startResult.status,
        0,
        `agent start failed\nstdout:\n${startResult.stdout}\nstderr:\n${startResult.stderr}`,
      );
      assert.match(startResult.stderr, /已启动|已在运行/);

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(
        healthResult.status,
        0,
        `agent health failed\nstdout:\n${healthResult.stdout}\nstderr:\n${healthResult.stderr}`,
      );
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const runningEntry = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(runningEntry);
      assert.equal(runningEntry.healthy, true);
      assert.match(runningEntry.message, /运行中|可连接/);

      const stopResult = runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      assert.equal(
        stopResult.status,
        0,
        `agent stop failed\nstdout:\n${stopResult.stdout}\nstderr:\n${stopResult.stderr}`,
      );
      assert.match(stopResult.stderr, /已停止|当前未运行/);

      const healthAfterStopResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(
        healthAfterStopResult.status,
        1,
        `agent health after stop should report unhealthy\nstdout:\n${healthAfterStopResult.stdout}\nstderr:\n${healthAfterStopResult.stderr}`,
      );
      const healthAfterStop = JSON.parse(healthAfterStopResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const stoppedEntry = healthAfterStop.find(
        (entry) => entry.agentName === "http-fixture-agent",
      );
      assert.ok(stoppedEntry);
      assert.equal(stoppedEntry.healthy, false);
      assert.match(stoppedEntry.message, /未运行|PID/);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: removing a running core-managed http agent stops it and deregisters it",
  {
    timeout: 120_000,
  },
  () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-remove-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = 37_000 + Math.floor(Math.random() * 5_000);

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, startResult.stderr);

      const removeResult = runRoll(["agent", "remove", "http-fixture-agent"], workspace);
      assert.equal(
        removeResult.status,
        0,
        `agent remove failed\nstdout:\n${removeResult.stdout}\nstderr:\n${removeResult.stderr}`,
      );
      assert.match(removeResult.stderr, /已移除/);

      const listResult = runRoll(["agent", "list", "--json"], workspace);
      assert.equal(listResult.status, 0, listResult.stderr);
      const agents = JSON.parse(listResult.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string };
      }>;
      assert.ok(!agents.some((agent) => agent.skill.name === "http-fixture-agent"));
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: updating a running local-path core-managed http agent refreshes metadata and restarts it",
  {
    timeout: 120_000,
  },
  () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-update-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = 42_000 + Math.floor(Math.random() * 5_000);

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, startResult.stderr);

      const pidPath = resolve(dataDir, "pids", "http-fixture-agent.pid");
      const originalPid = readFileSync(pidPath, "utf-8").trim();

      writeFileSync(
        resolve(agentDir, "SKILL.md"),
        `---
name: http-fixture-agent
description: Updated core managed HTTP fixture agent
---

Provides a single ping tool for lifecycle smoke tests after update.
`,
        "utf-8",
      );

      const updateResult = runRoll(["update"], workspace);
      assert.equal(
        updateResult.status,
        0,
        `roll update failed\nstdout:\n${updateResult.stdout}\nstderr:\n${updateResult.stderr}`,
      );
      assert.match(updateResult.stderr, /1 个 Agent 已更新|更新完成/);

      const updatedPid = readFileSync(pidPath, "utf-8").trim();
      assert.notEqual(updatedPid, originalPid);

      const listResult = runRoll(["agent", "list", "--json"], workspace);
      assert.equal(listResult.status, 0, listResult.stderr);
      const agents = JSON.parse(listResult.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string; readonly description: string };
      }>;
      const fixtureAgent = agents.find((agent) => agent.skill.name === "http-fixture-agent");
      assert.ok(fixtureAgent);
      assert.equal(fixtureAgent.skill.description, "Updated core managed HTTP fixture agent");

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(healthResult.status, 0, healthResult.stderr);
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
      }>;
      const updatedEntry = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(updatedEntry);
      assert.equal(updatedEntry.healthy, true);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: failed managed restart during update returns non-zero and cleans up the process",
  {
    timeout: 120_000,
  },
  () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-update-fail-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = 47_000 + Math.floor(Math.random() * 2_000);

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, startResult.stderr);

      const packageJsonPath = resolve(agentDir, "package.json");
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
        readonly rollAgent?: {
          readonly endpoint?: {
            readonly path?: string;
            readonly port?: number;
          };
        };
      };
      writeFileSync(
        packageJsonPath,
        JSON.stringify(
          {
            ...packageJson,
            rollAgent: {
              ...packageJson.rollAgent,
              endpoint: {
                ...packageJson.rollAgent?.endpoint,
                path: "/broken-mcp",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const updateResult = runRoll(["update"], workspace);
      assert.equal(
        updateResult.status,
        1,
        `roll update should fail when managed restart cannot become ready\nstdout:\n${updateResult.stdout}\nstderr:\n${updateResult.stderr}`,
      );
      assert.match(updateResult.stderr, /更新完成但有失败|重启失败|metadata 刷新或重启失败/);

      const pidPath = resolve(dataDir, "pids", "http-fixture-agent.pid");
      assert.equal(existsSync(pidPath), false);

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(healthResult.status, 1, healthResult.stderr);
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const entry = health.find((item) => item.agentName === "http-fixture-agent");
      assert.ok(entry);
      assert.equal(entry.healthy, false);
      assert.match(entry.message, /未运行|缺少活动 PID/);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
