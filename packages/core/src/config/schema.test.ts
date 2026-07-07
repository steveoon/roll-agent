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

  it("should parse runtime context window and compaction config", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: {
        contextWindow: 128_000,
        turnTimeoutMs: 45_000,
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.8,
          keepRecentTurns: 6,
          keepRecentTokens: 50_000,
        },
      },
      agents: { dataDir: "/tmp" },
    });

    assert.equal(result.success, true);
    assert.equal(result.success ? result.data.runtime.contextWindow : undefined, 128_000);
    assert.equal(result.success ? result.data.runtime.turnTimeoutMs : undefined, 45_000);
    assert.equal(result.success ? result.data.runtime.compaction.strategy : undefined, "truncate");
    assert.equal(result.success ? result.data.runtime.compaction.threshold : undefined, 0.8);
    assert.equal(result.success ? result.data.runtime.compaction.keepRecentTurns : undefined, 6);
    assert.equal(
      result.success ? result.data.runtime.compaction.keepRecentTokens : undefined,
      50_000,
    );
  });

  it("should default runtime compaction keepRecentTokens", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: {},
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, true);
    assert.equal(
      result.success ? result.data.runtime.compaction.keepRecentTokens : undefined,
      32_000,
    );
  });

  it("should default runtime bash to disabled with sane limits", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: {},
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, true);
    assert.equal(result.success ? result.data.runtime.bash.enabled : undefined, false);
    assert.equal(result.success ? result.data.runtime.bash.autoApproveSafe : undefined, true);
    assert.equal(result.success ? result.data.runtime.bash.defaultTimeoutMs : undefined, 10_000);
    assert.equal(result.success ? result.data.runtime.bash.maxCaptureBytes : undefined, 1_048_576);
  });

  it("should reject runtime bash timeout above the ceiling", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { bash: { maxTimeoutMs: 900_000 } },
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, false);
  });

  it("should reject invalid runtime compaction config", () => {
    const invalidStrategy = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { strategy: "drop" } },
      agents: { dataDir: "/tmp" },
    });
    const invalidThreshold = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { threshold: 1 } },
      agents: { dataDir: "/tmp" },
    });
    const invalidKeepRecentTurns = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { keepRecentTurns: 0 } },
      agents: { dataDir: "/tmp" },
    });
    const invalidTurnTimeout = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { turnTimeoutMs: 1000 },
      agents: { dataDir: "/tmp" },
    });

    assert.equal(invalidStrategy.success, false);
    assert.equal(invalidThreshold.success, false);
    assert.equal(invalidKeepRecentTurns.success, false);
    assert.equal(invalidTurnTimeout.success, false);
  });
});
