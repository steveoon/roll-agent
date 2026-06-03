import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { rollConfigSchema } from "./schema.ts";

describe("rollConfigSchema", () => {
  it("should validate a valid config", () => {
    const result = rollConfigSchema.safeParse({
      llm: {
        defaultProvider: DEFAULT_CONFIG.llm.defaultProvider,
        defaultModel: DEFAULT_CONFIG.llm.defaultModel,
        providers: {
          anthropic: { apiKey: "test-key" },
        },
      },
      ask: { confirmThreshold: 0.5 },
      agents: { dataDir: "~/.roll-agent/agents" },
    });
    assert.equal(result.success, true);
  });

  it("should reject invalid ask confirm threshold", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: { confirmThreshold: "invalid" },
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, false);
  });
});
