import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LLMEngine } from "./engine.ts";
import type { RollConfig } from "../config/schema.ts";

const baseConfig: RollConfig = {
  llm: {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    providers: {
      anthropic: { apiKey: "test-key" },
    },
  },
  ask: {},
  agents: { dataDir: "/tmp/agents" },
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
