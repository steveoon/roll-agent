import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { SkillLibrary } from "../skills/contracts.ts";
import { AgentSession } from "./agent-session.ts";

function library(name: string, description: string, onLoad: () => void = () => {}): SkillLibrary {
  const summary = { name, description, source: "project" as const };
  return {
    list: () => [summary],
    load: (input) => {
      assert.equal(input, name, "execution uses the same catalog as the request");
      onLoad();
      return { summary, content: description, referencePaths: [] };
    },
    loadReference: () => undefined,
  };
}

function skillTool(options: LanguageModelV4CallOptions) {
  return options.tools?.find((tool) => tool.type === "function" && tool.name === "roll__skill");
}

function names(options: LanguageModelV4CallOptions) {
  const tool = skillTool(options);
  if (tool === undefined) return [];
  assert.equal(tool.type, "function");
  const property = tool.inputSchema.properties?.["name"];
  assert.ok(property && typeof property === "object");
  return property.enum;
}

function system(options: LanguageModelV4CallOptions) {
  return options.prompt.find((message) => message.role === "system")?.content ?? "";
}

function response(calls: readonly string[], step: number) {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    ...calls.map((name, index) => ({
      type: "tool-call" as const,
      toolCallId: `call-${String(step)}-${String(index)}`,
      toolName: "roll__skill",
      input: JSON.stringify({ name, reference: null }),
    })),
    ...(calls.length > 0
      ? []
      : [
          { type: "text-start", id: "text" } as const,
          { type: "text-delta", id: "text", delta: "done" } as const,
          { type: "text-end", id: "text" } as const,
        ]),
    {
      type: "finish",
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      finishReason: {
        unified: calls.length > 0 ? "tool-calls" : "stop",
        raw: calls.length > 0 ? "tool-calls" : "stop",
      },
    },
  ];
  return {
    stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
  };
}

async function send(session: AgentSession, text: string) {
  const events = [];
  for await (const event of session.send(text)) events.push(event);
  assert.deepEqual(
    events.filter((event) => event.type === "error"),
    [],
  );
  return events;
}

test("skill catalog refreshes between model requests, while a tool batch shares its snapshot", async () => {
  let scans = 0;
  const loads: string[] = [];
  const fresh = library("fresh", "fresh description", () => {
    loads.push("fresh");
    current = undefined;
  });
  const old = library("old", "old description", () => {
    loads.push("old");
    current = fresh;
  });
  let current: SkillLibrary | undefined = old;
  const captured: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const step = captured.length;
      captured.push(options);
      assert.deepEqual(names(options), [["old"], ["fresh"], []][step]);
      assert.equal(
        options.tools?.filter((tool) => tool.name.startsWith("roll__skill")).length ?? 0,
        step === 2 ? 0 : 1,
      );
      if (step === 1) {
        assert.match(system(options), /fresh description/);
        assert.doesNotMatch(system(options), /old description/);
      }
      return response(step === 0 ? ["old", "old"] : step === 1 ? ["fresh"] : [], step);
    },
  });
  const session = new AgentSession({
    id: "refresh-during-turn",
    model,
    sources: [],
    maxSteps: 8,
    skillLibrary: old,
    refreshSkillLibrary: async () => {
      scans += 1;
      return current;
    },
  });
  try {
    const events = await send(session, "read the skills");
    assert.equal(captured.length, 3, "shape refresh must not duplicate model requests");
    assert.equal(scans, 3, "one scan per model request, not per tool or shape retry");
    assert.deepEqual(loads, ["old", "old", "fresh"]);
    assert.equal(
      events.filter((event) => event.type === "tool-result" && !event.isError).length,
      3,
    );
  } finally {
    await session.close();
  }
});

test("an empty catalog can gain skills; unchanged names reuse the schema and load the latest library", async () => {
  let current: SkillLibrary | undefined;
  const loaded: string[] = [];
  const captured: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const step = captured.length;
      captured.push(options);
      return response(step === 1 || step === 3 ? ["demo"] : [], step);
    },
  });
  const session = new AgentSession({
    id: "empty-then-refresh",
    model,
    sources: [],
    maxSteps: 5,
    refreshSkillLibrary: async () => current,
  });
  try {
    await send(session, "empty");
    assert.deepEqual(names(captured[0]!), []);
    current = library("demo", "first description", () => loaded.push("first"));
    await send(session, "load");
    current = library("demo", "updated description", () => loaded.push("updated"));
    await send(session, "load updated");
    assert.deepEqual(loaded, ["first", "updated"]);
    assert.equal(captured.length, 5);
    const first = skillTool(captured[1]!);
    const updated = skillTool(captured[3]!);
    assert.ok(first?.type === "function" && updated?.type === "function");
    assert.strictEqual(first.inputSchema, updated.inputSchema, "stable enum keeps cached schema");
    assert.match(system(captured[3]!), /updated description/);
    assert.doesNotMatch(system(captured[3]!), /first description/);
  } finally {
    await session.close();
  }
});

test("freshly discovered explicit skills are available before the first model request", async () => {
  let loads = 0;
  const current = library("new-skill", "fresh explicit instructions", () => {
    loads += 1;
  });
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      assert.deepEqual(names(options), ["new-skill"]);
      assert.match(JSON.stringify(options.prompt), /fresh explicit instructions/);
      return response([], 0);
    },
  });
  const session = new AgentSession({
    id: "new-explicit-skill",
    model,
    sources: [],
    maxSteps: 2,
    refreshSkillLibrary: async () => current,
  });
  try {
    await send(session, "/new-skill explain");
    assert.equal(loads, 1);
  } finally {
    await session.close();
  }
});

test("agent refresh during an in-flight model request does not change that request's lookup", async () => {
  const loaded: string[] = [];
  const old = library("old", "old", () => loaded.push("old"));
  const fresh = library("fresh", "fresh", () => loaded.push("fresh"));
  const source = {
    agentName: "fixture",
    client: new Client({ name: "fixture", version: "1" }),
    tools: [],
  };
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const step = calls++;
      if (step === 0) {
        assert.deepEqual(names(options), ["old"]);
        session.applyAgentRefresh({ source, skillLibrary: fresh });
      } else {
        assert.deepEqual(names(options), ["fresh"]);
      }
      return response(step === 0 ? ["old"] : step === 1 ? ["fresh"] : [], step);
    },
  });
  const session = new AgentSession({
    id: "in-flight-refresh",
    model,
    sources: [source],
    maxSteps: 6,
    skillLibrary: old,
  });
  try {
    await send(session, "read");
    assert.deepEqual(loaded, ["old", "fresh"]);
    assert.equal(calls, 3);
  } finally {
    await session.close();
  }
});
