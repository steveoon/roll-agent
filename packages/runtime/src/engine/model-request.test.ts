import { test } from "node:test";
import assert from "node:assert/strict";
import { streamText, tool, jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { buildSessionModelRequest } from "./model-request.ts";
import { estimatePreparedRequest } from "./request-budget.ts";

test("ordinary user messages preserve calibration shape while actual skill body changes invalidate it", () => {
  const build = (prompt: string, body = "") =>
    buildSessionModelRequest({
      history: [{ role: "user", content: prompt }],
      system: "system",
      tools: {},
      capabilityReminder: "same capabilities",
      project: (messages) => [...messages],
      explicitSkill: {
        userPrompt: prompt,
        modelUserContent: body + prompt,
        skillNames: body ? ["fixture"] : [],
      },
    });
  assert.equal(build("first").shapeContext, build("different prompt").shapeContext);
  assert.equal(build("first", "body\n").shapeContext, build("next", "body\n").shapeContext);
  assert.notEqual(build("first", "body\n").shapeContext, build("first", "changed\n").shapeContext);
});

test("shared production projection injects current Skill and reminders once; SDK prepares actual schemas", async () => {
  let descriptions = 0;
  const request = buildSessionModelRequest({
    history: [{ role: "user", content: "/fixture do it" }],
    explicitSkill: {
      userPrompt: "do it",
      skillNames: ["fixture"],
      modelUserContent: "CURRENT_SKILL_BODY\ndo it",
    },
    capabilityReminder: "CAPABILITY_SENTINEL",
    checkpointReminder: "CHECKPOINT_SENTINEL",
    system: "SYSTEM_SENTINEL",
    tools: {
      inspect: tool({
        description: () => {
          descriptions += 1;
          return "RESOLVED_DESCRIPTION";
        },
        inputSchema: jsonSchema({
          type: "object",
          properties: { requiredField: { type: "string" } },
        }),
      }),
    },
    providerOptions: { mock: { effort: "high" } },
    project: (messages) => [...messages],
  });
  assert.equal(JSON.stringify(request.messages).split("CURRENT_SKILL_BODY").length, 2);
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      const budget = estimatePreparedRequest(params, { provider: "mock", model: "fixture" }, 0);
      assert.ok(
        budget.systemTokens > 0 &&
          budget.messageTokens > 0 &&
          budget.toolTokens > 0 &&
          budget.optionTokens > 0,
      );
      assert.match(JSON.stringify(params.prompt), /CAPABILITY_SENTINEL.*CHECKPOINT_SENTINEL/s);
      assert.match(JSON.stringify(params.tools), /RESOLVED_DESCRIPTION|requiredField/);
      assert.deepEqual(params.providerOptions, request.providerOptions);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
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
  const result = streamText({ model, ...request });
  await result.consumeStream();
  assert.equal(await result.text, "ok");
  assert.equal(
    descriptions,
    2,
    "SDK prepares descriptions; budget layer never invokes a third resolution",
  );
  assert.deepEqual(request.messages.filter((m) => m.role === "user").length, 1);
});
