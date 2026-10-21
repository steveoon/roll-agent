import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtime from "@roll-agent/runtime";
import { MockLanguageModelV4 } from "ai/test";
import { rollConfigSchema } from "../config/schema.ts";
import {
  createChatEngine,
  CHAT_ENGINE_SURFACES,
  type ChatEngineOptions,
} from "./engine-factory.ts";

test("factory admits recovery only for interactive Ink and basic REPL surfaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-recovery-surfaces-"));
  const store = new runtime.ThreadStore(dir);
  const config = rollConfigSchema.parse({
    ask: {},
    llm: { defaultProvider: "openai", defaultModel: "fixture", providers: {} },
    agents: { dataDir: join(dir, "agents") },
  });
  const recovery = { isRecoverable: () => true, prepare: async () => {} };
  let captured: ChatEngineOptions | undefined;
  class CapturingEngine extends runtime.ConversationEngine {
    constructor(options: ChatEngineOptions) {
      captured = options;
      super({
        ...options,
        sources: [],
        skillLibrary: null,
        workspaceInstructions: null,
        fileToolsEnabled: false,
        sessionExecEnabled: false,
      });
    }
  }
  try {
    for (const surface of Object.values(CHAT_ENGINE_SURFACES)) {
      const engine = createChatEngine({
        runtime: { ...runtime, ConversationEngine: CapturingEngine },
        config,
        model: new MockLanguageModelV4({}),
        store,
        surface,
        modelRecovery: recovery,
      });
      try {
        assert.equal(
          captured?.modelRecovery,
          surface === "ink" || surface === "basic-repl" ? recovery : undefined,
          surface,
        );
      } finally {
        await engine.dispose();
      }
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
