import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ConversationEngine } from "@roll-agent/runtime";
import type { AgentHost } from "@roll-agent/runtime/host-contracts";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { rollConfigSchema } from "../config/schema.ts";
import { createSkillLibrary } from "../skills/library.ts";
import { mapRuntimeSettings } from "./engine-factory.ts";

for (const disabled of [false, true]) {
  test(`disk skill changes reach the next model request (disabled=${String(disabled)})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-skill-refresh-"));
    const skillDir = join(dir, ".agents", "skills", "fixture");
    mkdirSync(skillDir, { recursive: true });
    const writeSkill = (name: string) =>
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} description\n---\nbody`,
      );
    writeSkill("before");
    const discover = () => createSkillLibrary({ cwd: dir, home: dir });
    let refreshes = 0;
    const host: AgentHost = {
      prepare: async () => ({ sources: [], skillLibrary: discover() }),
      refreshSkills: async () => {
        refreshes += 1;
        return discover();
      },
      refresh: async () => {
        throw new Error("skill discovery must not reconnect agents");
      },
      updateSampling: () => {},
      dispose: async () => {},
    };
    const requests: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        requests.push(options);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const config = rollConfigSchema.parse({
      llm: { defaultProvider: "mock", defaultModel: "mock", providers: {} },
      ask: {},
      agents: { dataDir: dir },
    });
    const engine = new ConversationEngine({
      settings: mapRuntimeSettings(config),
      provider: "mock",
      modelName: "mock",
      model,
      agentHost: host,
      workspaceInstructions: null,
      shellProfile: null,
      fileToolsEnabled: false,
      sessionExecEnabled: false,
      inspectVcsContext: () => undefined,
      ...(disabled ? { skillLibrary: null } : {}),
    });
    try {
      const session = await engine.createSession();
      for (const expected of ["before", "after", undefined]) {
        if (expected === "after") writeSkill(expected);
        if (expected === undefined) rmSync(skillDir, { recursive: true });
        for await (const event of session.send("inspect the catalog")) {
          assert.notEqual(event.type, "error");
        }
        const request = requests.at(-1);
        assert.ok(request);
        const tool = request.tools?.find((item) => item.name === "roll__skill");
        if (disabled || expected === undefined) {
          assert.equal(tool, undefined);
        } else {
          assert.ok(tool?.type === "function");
          const property = tool.inputSchema.properties?.["name"];
          assert.ok(property && typeof property === "object");
          assert.deepEqual(property.enum, [expected]);
          assert.equal(tool.strict, true);
          const prompt = request.prompt.find((message) => message.role === "system");
          assert.ok(prompt?.content.includes(`${expected} description`));
        }
      }
      assert.equal(refreshes, disabled ? 0 : 3);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
