import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./loader.ts";

function createTmpDir(): string {
  const dir = join(tmpdir(), `roll-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return default config when no config file exists", () => {
    const { config, configPath } = loadConfig({ cwd: tmpDir });
    assert.equal(configPath, undefined);
    assert.equal(config.llm.defaultProvider, "anthropic");
    assert.equal(config.router.mode, "declarative");
  });

  it("should load and parse a valid YAML config", () => {
    const yaml = `
llm:
  default-provider: qwen
  default-model: qwen-plus
  providers:
    qwen:
      api-key: test-key-123

router:
  mode: llm

agents:
  data-dir: /tmp/roll-agents
`;
    writeFileSync(join(tmpDir, "roll.config.yaml"), yaml);

    const { config, configPath } = loadConfig({ cwd: tmpDir });
    assert.ok(configPath?.endsWith("roll.config.yaml"));
    assert.equal(config.llm.defaultProvider, "qwen");
    assert.equal(config.llm.defaultModel, "qwen-plus");
    assert.equal(config.llm.providers["qwen"]?.apiKey, "test-key-123");
    assert.equal(config.router.mode, "llm");
    assert.equal(config.agents.dataDir, "/tmp/roll-agents");
  });

  it("should resolve environment variables", () => {
    process.env["ROLL_TEST_API_KEY"] = "resolved-key";

    const yaml = `
llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-20250514
  providers:
    anthropic:
      api-key: \${ROLL_TEST_API_KEY}

router:
  mode: declarative

agents:
  data-dir: /tmp/agents
`;
    writeFileSync(join(tmpDir, "roll.config.yaml"), yaml);

    const { config } = loadConfig({ cwd: tmpDir });
    assert.equal(config.llm.providers["anthropic"]?.apiKey, "resolved-key");

    delete process.env["ROLL_TEST_API_KEY"];
  });

  it("should keep unresolved env vars as-is", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers:
    anthropic:
      api-key: \${NONEXISTENT_VAR_12345}

router:
  mode: declarative

agents:
  data-dir: /tmp/agents
`;
    writeFileSync(join(tmpDir, "roll.config.yaml"), yaml);

    const { config } = loadConfig({ cwd: tmpDir });
    // eslint-disable-next-line no-template-curly-in-string
    assert.equal(config.llm.providers["anthropic"]?.apiKey, "${NONEXISTENT_VAR_12345}");
  });

  it("should merge with defaults for partial config", () => {
    const yaml = `
llm:
  default-provider: openai
  default-model: gpt-4
  providers: {}
`;
    writeFileSync(join(tmpDir, "roll.config.yaml"), yaml);

    const { config } = loadConfig({ cwd: tmpDir });
    assert.equal(config.llm.defaultProvider, "openai");
    // router and agents should come from defaults
    assert.equal(config.router.mode, "declarative");
    assert.ok(config.agents.dataDir.length > 0);
  });

  it("should throw on invalid config", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}

router:
  mode: invalid-mode

agents:
  data-dir: /tmp
`;
    writeFileSync(join(tmpDir, "roll.config.yaml"), yaml);

    assert.throws(
      () => loadConfig({ cwd: tmpDir }),
      (err: Error) => err.message.includes("Config validation failed"),
    );
  });

  it("should accept explicit config path", () => {
    const customPath = join(tmpDir, "custom.yaml");
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}

router:
  mode: auto

agents:
  data-dir: /tmp/custom
`;
    writeFileSync(customPath, yaml);

    const { config, configPath } = loadConfig({ configPath: customPath });
    assert.equal(configPath, customPath);
    assert.equal(config.router.mode, "auto");
  });

  it("should throw when explicit config path does not exist", () => {
    assert.throws(
      () => loadConfig({ configPath: join(tmpDir, "nonexistent.yaml") }),
      (err: Error) => err.message.includes("Config file not found"),
    );
  });

  it("should expand tilde in data-dir", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}

router:
  mode: declarative

agents:
  data-dir: ~/.roll-agent/agents
`;
    writeFileSync(join(tmpDir, "roll.config.yaml"), yaml);

    const { config } = loadConfig({ cwd: tmpDir });
    assert.ok(!config.agents.dataDir.startsWith("~"));
    assert.ok(config.agents.dataDir.includes("roll-agent"));
  });
});
