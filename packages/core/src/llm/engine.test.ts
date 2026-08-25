import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { LLMEngine } from "./engine.ts";
import type { RollConfig } from "../config/schema.ts";

const baseConfig: RollConfig = {
  llm: {
    defaultProvider: DEFAULT_CONFIG.llm.defaultProvider,
    defaultModel: DEFAULT_CONFIG.llm.defaultModel,
    providers: {
      anthropic: { apiKey: "test-key" },
    },
  },
  ask: {},
  chat: DEFAULT_CONFIG.chat,
  runtime: DEFAULT_CONFIG.runtime,
  scheduler: DEFAULT_CONFIG.scheduler,
  skills: DEFAULT_CONFIG.skills,
  agents: { dataDir: "/tmp/agents" },
  install: DEFAULT_CONFIG.install,
  browser: DEFAULT_CONFIG.browser,
};

describe("LLMEngine", () => {
  it("should throw when provider is not configured", () => {
    const config: RollConfig = {
      ...baseConfig,
      llm: { ...baseConfig.llm, providers: {} },
    };
    const engine = new LLMEngine(config);

    assert.rejects(
      () => engine.generateText("test"),
      (err: Error) => err.message.includes("not configured"),
    );
  });

  it("should throw for unknown provider", () => {
    const engine = new LLMEngine(baseConfig);

    assert.rejects(
      () => engine.generateText("test", { provider: "nonexistent" }),
      (err: Error) => err.message.includes("not configured"),
    );
  });

  it("should be constructable with valid config", () => {
    const engine = new LLMEngine(baseConfig);
    assert.ok(engine);
  });
});
