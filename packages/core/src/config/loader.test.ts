import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./loader.ts";

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
    assert.equal(config.router.mode, "declarative");
  });

  it("should load and parse a valid YAML config", () => {
    const yaml = `
llm:
  default-provider: openai
  default-model: gpt-4o
  providers:
    openai:
      api-key: test-key

router:
  mode: llm

agents:
  data-dir: /tmp/agents
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);

    const { config, configPath } = loadConfig({ cwd: tmpDir });
    assert.ok(configPath);
    assert.equal(config.llm.defaultProvider, "openai");
    assert.equal(config.llm.defaultModel, "gpt-4o");
    assert.equal(config.llm.providers["openai"]?.apiKey, "test-key");
    assert.equal(config.router.mode, "llm");
    assert.equal(config.agents.dataDir, "/tmp/agents");
  });

  it("should convert kebab-case keys to camelCase", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
router:
  mode: declarative
  confirm-threshold: 0.5
agents:
  data-dir: /tmp/test
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: tmpDir });
    assert.equal(config.router.confirmThreshold, 0.5);
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
router:
  mode: declarative
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
router:
  mode: auto
agents:
  data-dir: /tmp/test
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), yaml);
    const { config } = loadConfig({ cwd: childDir });
    assert.equal(config.llm.defaultProvider, "qwen");
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

  it("should expand tilde in dataDir", () => {
    const yaml = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
router:
  mode: declarative
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
    assert.equal(config.router.mode, "declarative");
    assert.ok(config.agents.dataDir);
  });
});
