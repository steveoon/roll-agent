import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./defaults.ts";
import {
  CHAT_SCREEN_MODES,
  CHAT_THINKING_DISPLAY_MODES,
  chatScreenModeSchema,
  chatThinkingDisplaySchema,
  rollConfigSchema,
} from "./schema.ts";

describe("rollConfigSchema", () => {
  it("builds DEFAULT_CONFIG from schema defaults plus the required seed", () => {
    assert.deepEqual(
      DEFAULT_CONFIG,
      rollConfigSchema.parse({
        llm: {
          defaultProvider: "anthropic",
          defaultModel: "claude-sonnet-4-6",
          providers: {},
        },
        ask: {},
        agents: { dataDir: "~/.roll-agent/agents" },
      }),
    );
    assert.equal(DEFAULT_CONFIG.runtime.turnTimeoutMs, 300_000);
    assert.equal(DEFAULT_CONFIG.runtime.agentBootstrap.timeoutMs, 60_000);
    assert.equal(DEFAULT_CONFIG.chat.screenMode, "auto");
    assert.equal(DEFAULT_CONFIG.chat.thinkingDisplay, "collapsed");
    assert.equal(DEFAULT_CONFIG.install.networkTimeoutMs, 120_000);
    assert.deepEqual(DEFAULT_CONFIG.browser.instances, {});
  });

  it("defaults chat.instructions to auto and accepts off or a path", () => {
    assert.equal(DEFAULT_CONFIG.chat.instructions, "auto");
    for (const value of ["auto", "off", "docs/RULES.md", "~/rules.md"]) {
      const result = rollConfigSchema.safeParse({
        llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
        ask: {},
        agents: { dataDir: "~/.roll-agent/agents" },
        chat: { instructions: value },
      });
      assert.equal(result.success, true, value);
      assert.equal(result.success ? result.data.chat.instructions : undefined, value);
    }
    const empty = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "~/.roll-agent/agents" },
      chat: { instructions: "   " },
    });
    assert.equal(empty.success, false);
  });

  it("should validate chat screen mode from one shared runtime enum", () => {
    assert.deepEqual(chatScreenModeSchema.options, [...CHAT_SCREEN_MODES]);

    for (const screenMode of CHAT_SCREEN_MODES) {
      const result = rollConfigSchema.safeParse({
        llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
        ask: {},
        chat: { screenMode },
        agents: { dataDir: "/tmp" },
      });
      assert.equal(result.success, true, screenMode);
      assert.equal(result.success ? result.data.chat.screenMode : undefined, screenMode);
    }

    const invalid = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      chat: { screenMode: "split" },
      agents: { dataDir: "/tmp" },
    });
    assert.equal(invalid.success, false);
  });

  it("should validate chat thinking display from one shared runtime enum", () => {
    assert.deepEqual(chatThinkingDisplaySchema.options, [...CHAT_THINKING_DISPLAY_MODES]);

    for (const thinkingDisplay of CHAT_THINKING_DISPLAY_MODES) {
      const result = rollConfigSchema.safeParse({
        llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
        ask: {},
        chat: { thinkingDisplay },
        agents: { dataDir: "/tmp" },
      });
      assert.equal(result.success, true, thinkingDisplay);
      assert.equal(result.success ? result.data.chat.thinkingDisplay : undefined, thinkingDisplay);
    }

    const invalid = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      chat: { thinkingDisplay: "hidden" },
      agents: { dataDir: "/tmp" },
    });
    assert.equal(invalid.success, false);
  });

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
        agentBootstrap: {
          timeoutMs: 90_000,
        },
        compaction: {
          enabled: true,
          strategy: "truncate",
          timeoutMs: 180_000,
          thinkingLevel: "high",
          maxOutputTokens: 16_384,
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
    assert.equal(result.success ? result.data.runtime.agentBootstrap.timeoutMs : undefined, 90_000);
    assert.equal(result.success ? result.data.runtime.compaction.strategy : undefined, "truncate");
    assert.equal(result.success ? result.data.runtime.compaction.timeoutMs : undefined, 180_000);
    assert.equal(result.success ? result.data.runtime.compaction.thinkingLevel : undefined, "high");
    assert.equal(
      result.success ? result.data.runtime.compaction.maxOutputTokens : undefined,
      16_384,
    );
    assert.equal(result.success ? result.data.runtime.compaction.threshold : undefined, 0.8);
    assert.equal(result.success ? result.data.runtime.compaction.keepRecentTurns : undefined, 6);
    assert.equal(
      result.success ? result.data.runtime.compaction.keepRecentTokens : undefined,
      50_000,
    );
  });

  it("should default runtime compaction budgets", () => {
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
    assert.equal(result.success ? result.data.runtime.thinkingLevel : undefined, "medium");
    assert.equal(result.success ? result.data.runtime.agentBootstrap.timeoutMs : undefined, 60_000);
    assert.equal(result.success ? result.data.runtime.compaction.timeoutMs : undefined, 120_000);
    assert.equal(
      result.success ? result.data.runtime.compaction.maxOutputTokens : undefined,
      8_192,
    );
    assert.equal(
      result.success ? result.data.runtime.compaction.thinkingLevel : "present",
      undefined,
    );
  });

  it("should default runtime shell to disabled with sane limits", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: {},
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, true);
    assert.equal(result.success ? result.data.runtime.shell.enabled : undefined, false);
    assert.equal(result.success ? result.data.runtime.shell.autoApproveSafe : undefined, true);
    assert.equal(result.success ? result.data.runtime.shell.defaultTimeoutMs : undefined, 10_000);
    assert.equal(result.success ? result.data.runtime.shell.maxCaptureBytes : undefined, 1_048_576);
  });

  it("should reject runtime shell timeout above the ceiling", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { shell: { maxTimeoutMs: 900_000 } },
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
    const invalidCompactionTimeout = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { timeoutMs: 9_999 } },
      agents: { dataDir: "/tmp" },
    });
    const excessiveCompactionTimeout = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { timeoutMs: 600_001 } },
      agents: { dataDir: "/tmp" },
    });
    const invalidCompactionThinkingLevel = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { thinkingLevel: "maximum" } },
      agents: { dataDir: "/tmp" },
    });
    const insufficientCompactionOutput = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { maxOutputTokens: 2_047 } },
      agents: { dataDir: "/tmp" },
    });
    const excessiveCompactionOutput = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { compaction: { maxOutputTokens: 32_769 } },
      agents: { dataDir: "/tmp" },
    });
    const invalidTurnTimeout = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { turnTimeoutMs: 1000 },
      agents: { dataDir: "/tmp" },
    });
    const insufficientAgentBootstrapTimeout = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { agentBootstrap: { timeoutMs: 4_999 } },
      agents: { dataDir: "/tmp" },
    });
    const excessiveAgentBootstrapTimeout = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      runtime: { agentBootstrap: { timeoutMs: 300_001 } },
      agents: { dataDir: "/tmp" },
    });

    assert.equal(invalidStrategy.success, false);
    assert.equal(invalidThreshold.success, false);
    assert.equal(invalidKeepRecentTurns.success, false);
    assert.equal(invalidCompactionTimeout.success, false);
    assert.equal(excessiveCompactionTimeout.success, false);
    assert.equal(invalidCompactionThinkingLevel.success, false);
    assert.equal(insufficientCompactionOutput.success, false);
    assert.equal(excessiveCompactionOutput.success, false);
    assert.equal(invalidTurnTimeout.success, false);
    assert.equal(insufficientAgentBootstrapTimeout.success, false);
    assert.equal(excessiveAgentBootstrapTimeout.success, false);
  });
  it("should default scheduler section", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, true);
    if (!result.success) {
      return;
    }
    assert.equal(result.data.scheduler.dataDir, "~/.roll-agent/scheduler");
    assert.equal(result.data.scheduler.maxSchedules, 50);
    assert.equal(result.data.scheduler.maxConcurrentRuns, 2);
    assert.deepEqual(result.data.scheduler.env, {});
  });

  it("should accept scheduler env record and reject non-string values", () => {
    const accepted = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "/tmp" },
      scheduler: { env: { HTTP_PROXY: "http://127.0.0.1:7890", PATH: "/custom/bin" } },
    });
    assert.equal(accepted.success, true);
    if (accepted.success) {
      assert.deepEqual(accepted.data.scheduler.env, {
        HTTP_PROXY: "http://127.0.0.1:7890",
        PATH: "/custom/bin",
      });
    }
    const rejected = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "/tmp" },
      scheduler: { env: { COUNT: 3 } },
    });
    assert.equal(rejected.success, false);
  });

  it("should reject scheduler max-concurrent-runs above 8", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "/tmp" },
      scheduler: { maxConcurrentRuns: 9 },
    });
    assert.equal(result.success, false);
  });
});
