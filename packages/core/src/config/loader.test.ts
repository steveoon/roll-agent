import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { inspectConfigFile, loadAgentsConfig, loadConfig, validateConfigText } from "./loader.ts";
import { getAgentEnv } from "./helpers.ts";

/** 创建临时目录用于测试 */
function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return default config when no config file exists", () => {
    const { config, configPath } = loadConfig({ cwd: tmpDir });
    assert.equal(configPath, undefined);
    assert.equal(config.llm.defaultProvider, "anthropic");
    assert.deepEqual(config.ask, {});
  });

  it("should load and parse a valid YAML config", () => {
    const yaml = `
llm:
  default-provider: openai
  default-model: gpt-4o
  providers:
    openai:
      api-key: test-key

ask:
  llm-model: gpt-4.1-mini
  confirm-threshold: 0.8

agents:
  data-dir: /tmp/agents
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);

    const { config, configPath } = loadConfig({ cwd: tmpDir });
    assert.ok(configPath);
    assert.equal(config.llm.defaultProvider, "openai");
    assert.equal(config.llm.defaultModel, "gpt-4o");
    assert.equal(config.llm.providers["openai"]?.apiKey, "test-key");
    assert.equal(config.ask.llmModel, "gpt-4.1-mini");
    assert.equal(config.ask.confirmThreshold, 0.8);
    assert.equal(config.agents.dataDir, "/tmp/agents");
  });

  it("should convert kebab-case keys to camelCase", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask:
  confirm-threshold: 0.5
agents:
  data-dir: /tmp/test
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: tmpDir });
    assert.equal(config.ask.confirmThreshold, 0.5);
  });

  it("should resolve kebab-case agent env keys through getAgentEnv", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: /tmp/test
  env:
    smart-reply-agent:
      REPLY_AUTHORITY_URL: https://reply-authority.example.com
      REPLY_AUTHORITY_BEARER_TOKEN: test-token
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: tmpDir });

    assert.deepEqual(getAgentEnv(config, "smart-reply-agent"), {
      REPLY_AUTHORITY_URL: "https://reply-authority.example.com",
      REPLY_AUTHORITY_BEARER_TOKEN: "test-token",
    });
  });

  it("should preserve kebab-case keys under agents.env (dynamic record)", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: /tmp/test
  env:
    smart-reply-agent:
      REPLY_AUTHORITY_URL: https://reply-authority.example.com
    browser-use-agent:
      REPLY_AUTHORITY_KEYS_URL: https://reply-authority.example.com/keys
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: tmpDir });

    const envMap = config.agents.env ?? {};
    assert.ok("smart-reply-agent" in envMap, "kebab-case agent name should be preserved");
    assert.ok("browser-use-agent" in envMap, "kebab-case agent name should be preserved");
    assert.equal("smartReplyAgent" in envMap, false, "should not introduce camelCase variant");
    assert.equal("browserUseAgent" in envMap, false, "should not introduce camelCase variant");
  });

  it("should resolve environment variables", () => {
    process.env["ROLL_TEST_API_KEY"] = "resolved-key";
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers:
    anthropic:
      api-key: \${ROLL_TEST_API_KEY}
ask:
  confirm-threshold: 0.5
agents:
  data-dir: /tmp/test
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: tmpDir });
    assert.equal(config.llm.providers["anthropic"]?.apiKey, "resolved-key");
    delete process.env["ROLL_TEST_API_KEY"];
  });

  it("should find config in parent directory", () => {
    const childDir = resolve(tmpDir, "sub", "deep");
    mkdirSync(childDir, { recursive: true });
    const yaml = `
llm:
  default-provider: qwen
  default-model: qwen-plus
  providers: {}
ask:
  llm-model: qwen-plus
agents:
  data-dir: /tmp/test
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: childDir });
    assert.equal(config.llm.defaultProvider, "qwen");
    assert.equal(config.ask.llmModel, "qwen-plus");
  });

  it("should throw for explicit path that does not exist", () => {
    assert.throws(
      () => loadConfig({ configPath: resolve(tmpDir, "nonexistent.yaml") }),
      (err: Error) => err.message.includes("not found"),
    );
  });

  it("should throw for invalid YAML content", () => {
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), "just a string");
    assert.throws(
      () => loadConfig({ cwd: tmpDir }),
      (err: Error) => err.message.includes("Invalid config file"),
    );
  });

  it("should throw with line and column for YAML syntax errors", () => {
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), "llm: [\n");
    assert.throws(
      () => loadConfig({ cwd: tmpDir }),
      (err: Error) =>
        err.message.includes("Invalid YAML syntax in config file") &&
        err.message.includes("line 2, column 1"),
    );
  });

  it("should expand tilde in dataDir", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: ~/my-agents
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: tmpDir });
    assert.ok(!config.agents.dataDir.startsWith("~"));
    assert.ok(config.agents.dataDir.includes("my-agents"));
  });

  it("should deep merge with defaults", () => {
    const yaml = `
llm:
  default-provider: openai
  default-model: gpt-4o
  providers: {}
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: tmpDir });
    assert.deepEqual(config.ask, {});
    assert.ok(config.agents.dataDir);
  });

  it("should validate config text against schema", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask:
  confirm-threshold: invalid
agents:
  data-dir: /tmp/test
`;
    assert.throws(
      () => validateConfigText(yaml, resolve(tmpDir, "roll.config.yaml")),
      (err: Error) =>
        err.message.includes("Config validation failed") &&
        err.message.includes("ask.confirmThreshold"),
    );
  });

  it("should reject deprecated router config with migration guidance", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
router:
  mode: declarative
  llm-model: claude-3-5-sonnet
  confirm-threshold: 0.5
agents:
  data-dir: /tmp/test
`;
    assert.throws(
      () => validateConfigText(yaml, resolve(tmpDir, "roll.config.yaml")),
      (err: Error) =>
        err.message.includes("`router` 配置段已废弃") &&
        err.message.includes("ask.llm-model") &&
        err.message.includes("ask.confirm-threshold") &&
        err.message.includes("router.mode") &&
        err.message.includes("roll config migrate"),
    );
  });

  it("validateConfigText should reject YAML containing camelCase agent env keys", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: /tmp/test
  env:
    smartReplyAgent:
      REPLY_AUTHORITY_URL: https://legacy.example.com
`;

    assert.throws(
      () => validateConfigText(yaml, resolve(tmpDir, "roll.config.yaml")),
      (err: Error) =>
        err.message.includes("smartReplyAgent") && err.message.includes("roll config migrate"),
    );
  });

  it("loadAgentsConfig should block legacy camelCase agent env keys with migration guidance", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: /tmp/test
  env:
    smartReplyAgent:
      REPLY_AUTHORITY_URL: https://legacy.example.com
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);

    assert.throws(
      () => loadAgentsConfig({ cwd: tmpDir }),
      (err: Error) =>
        err.message.includes("smartReplyAgent") && err.message.includes("roll config migrate"),
    );
  });

  it("should inspect deprecated router config as needs-migration", () => {
    const configPath = resolve(tmpDir, "roll.config.yaml");
    writeFileSync(
      configPath,
      `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
router:
  llm-model: claude-sonnet-4-6
agents:
  data-dir: /tmp/test
`,
    );

    const inspection = inspectConfigFile({ cwd: tmpDir });
    assert.equal(inspection.status, "needs-migration");
    if (inspection.status !== "needs-migration") {
      return;
    }
    assert.equal(inspection.configPath, configPath);
    assert.equal(inspection.report.canAutoMigrate, true);
  });
});
