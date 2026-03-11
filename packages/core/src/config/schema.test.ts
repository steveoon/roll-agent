import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rollConfigSchema } from "./schema.ts";

describe("rollConfigSchema", () => {
  it("should validate a valid config", () => {
    const result = rollConfigSchema.safeParse({
      llm: {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-20250514",
        providers: {
          anthropic: { apiKey: "test-key" },
        },
      },
      router: { mode: "declarative" },
      agents: { dataDir: "~/.roll-agent/agents" },
    });
    assert.equal(result.success, true);
  });

  it("should reject invalid router mode", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      router: { mode: "invalid" },
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, false);
  });
});
