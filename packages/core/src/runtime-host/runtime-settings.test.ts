import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeSettingsSchema } from "@roll-agent/runtime/host-contracts";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { rollConfigSchema } from "../config/schema.ts";
import { mapRuntimeSettings } from "./engine-factory.ts";

test("Runtime execution defaults are identical to Core's validated defaults", () => {
  assert.deepEqual(mapRuntimeSettings(DEFAULT_CONFIG), runtimeSettingsSchema.parse({}));
});

test("Core projects every execution setting without credentials or host-only configuration", () => {
  const config = rollConfigSchema.parse({
    ...DEFAULT_CONFIG,
    llm: {
      defaultProvider: "mock",
      defaultModel: "test",
      providers: { mock: { apiKey: "SECRET_SENTINEL" } },
    },
    chat: { instructions: "./custom-instructions.md" },
    runtime: {
      maxSteps: 23,
      turnTimeoutMs: 91_000,
      contextWindow: 123_456,
      compaction: {
        enabled: false,
        strategy: "truncate",
        timeoutMs: 90_000,
        maxOutputTokens: 4096,
        threshold: 0.6,
        keepRecentTurns: 3,
        keepRecentTokens: 10_000,
        thinkingLevel: "low",
      },
      shell: {
        enabled: true,
        autoApproveSafe: false,
        defaultTimeoutMs: 2000,
        maxTimeoutMs: 4000,
        maxCaptureBytes: 65_536,
        maxModelOutputChars: 2048,
        session: { enabled: true, maxSessions: 2, defaultYieldMs: 500, maxOutputTokens: 512 },
      },
    },
  });
  const settings = mapRuntimeSettings(config);
  assert.deepEqual(settings, {
    maxSteps: 23,
    turnTimeoutMs: 91_000,
    contextWindow: 123_456,
    instructions: "./custom-instructions.md",
    compaction: {
      enabled: false,
      strategy: "truncate",
      timeoutMs: 90_000,
      maxOutputTokens: 4096,
      threshold: 0.6,
      keepRecentTurns: 3,
      keepRecentTokens: 10_000,
    },
    shell: config.runtime.shell,
  });
  assert.equal(JSON.stringify(settings).includes("SECRET_SENTINEL"), false);
  assert.equal("agents" in settings, false);
  assert.equal("install" in settings, false);
});
