import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import type { SkillLibrary } from "@roll-agent/core/skills/library";
import { ThreadStore } from "../store/thread-store.ts";
import { AgentSession } from "./agent-session.ts";
import { ConversationEngine } from "./conversation-engine.ts";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: usage(), finishReason: STOP },
  ];
}

function contextOverflowStep(): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "error", error: "context_length_exceeded" },
  ];
}

function streamChunks(chunks: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function textModel(text: string, onPrompt?: (prompt: string) => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      onPrompt?.(JSON.stringify(options.prompt));
      return streamChunks(textStep(text));
    },
  });
}

function demoLibrary(body: string, onLoad?: () => void): SkillLibrary {
  const summary = { name: "demo", description: "demo skill", source: "project" as const };
  return {
    list: () => [summary],
    load: (name) => {
      if (name !== summary.name) {
        return undefined;
      }
      onLoad?.();
      return { summary, content: body, referencePaths: [] };
    },
    loadReference: () => undefined,
  };
}

function runtimeConfig(dataDir: string) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir },
  });
}

async function drain(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const drained: unknown[] = [];
  for await (const event of events) {
    drained.push(event);
  }
  return drained;
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

test("显式 Skill 只持久化原始输入与轻量 checkpoint，内部和公开历史都不保存正文", async () => {
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "explicit-skill-public-history",
    model: textModel("done"),
    sources: [],
    maxSteps: 2,
    skillLibrary: demoLibrary("PRIVATE_SKILL_BODY"),
    onPersist: (messages) => persisted.push([...messages]),
  });

  try {
    await drain(session.send("/demo 修一下类型"));

    const stored = JSON.stringify(persisted);
    const visible = JSON.stringify(session.getMessages());
    assert.equal(persisted[0]?.[0]?.content, "/demo 修一下类型");
    assert.match(stored, /explicitSkillCheckpoint/u);
    assert.match(stored, /contentSha256/u);
    assert.doesNotMatch(stored, /PRIVATE_SKILL_BODY/u);
    assert.equal(session.getMessages()[0]?.content, "/demo 修一下类型");
    assert.doesNotMatch(visible, /PRIVATE_SKILL_BODY|explicitSkillCheckpoint|rollHarness/u);
  } finally {
    await session.close();
  }
});

test("后续普通 Turn 不重复展开已完成 Turn 的显式 Skill 正文", async () => {
  const prompts: string[] = [];
  const session = new AgentSession({
    id: "explicit-skill-current-turn-only",
    model: textModel("done", (prompt) => prompts.push(prompt)),
    sources: [],
    maxSteps: 2,
    skillLibrary: demoLibrary("CURRENT_TURN_ONLY_BODY"),
  });

  try {
    await drain(session.send("/demo first request"));
    await drain(session.send("continue"));
    await drain(session.send("/demo third request"));

    assert.equal(prompts.length, 3);
    assert.deepEqual(
      prompts.map((prompt) => occurrences(prompt, "CURRENT_TURN_ONLY_BODY")),
      [1, 0, 1],
    );
    assert.ok(prompts.every((prompt) => !prompt.includes("rollHarness")));
  } finally {
    await session.close();
  }
});

test("resume 不向后续普通 Turn 注入已完成 Turn 的持久化 Skill 快照", async () => {
  for (const currentSkillState of ["changed", "deleted"] as const) {
    const dir = mkdtempSync(join(tmpdir(), `roll-explicit-skill-${currentSkillState}-`));
    const store = new ThreadStore(join(dir, "threads"));
    let firstEngine: ConversationEngine | undefined;
    let resumedEngine: ConversationEngine | undefined;
    try {
      let initialLoads = 0;
      firstEngine = new ConversationEngine({
        config: runtimeConfig(dir),
        model: textModel("first done"),
        sources: [],
        store,
        skillLibrary: demoLibrary("SNAPSHOT_BODY_V1", () => {
          initialLoads += 1;
        }),
      });
      const firstSession = await firstEngine.createSession();
      const threadId = firstSession.id;
      await drain(firstSession.send("/demo first request"));

      const storedAfterFirstTurn = store.getMessages(threadId);
      assert.equal(storedAfterFirstTurn[0]?.content, "/demo first request");
      assert.match(JSON.stringify(storedAfterFirstTurn), /contentSha256/u);
      assert.doesNotMatch(JSON.stringify(storedAfterFirstTurn), /SNAPSHOT_BODY_V1/u);
      assert.equal(initialLoads, 1);

      await firstSession.close();
      await firstEngine.dispose();
      firstEngine = undefined;

      let currentLibraryLoads = 0;
      const resumedPrompts: string[] = [];
      resumedEngine = new ConversationEngine({
        config: runtimeConfig(dir),
        model: textModel("second done", (prompt) => resumedPrompts.push(prompt)),
        sources: [],
        store,
        skillLibrary:
          currentSkillState === "changed"
            ? demoLibrary("CURRENT_BODY_V2", () => {
                currentLibraryLoads += 1;
              })
            : null,
      });
      const resumed = await resumedEngine.resumeSession(threadId);
      await drain(resumed.send("continue"));

      assert.equal(resumedPrompts.length, 1);
      assert.equal(occurrences(resumedPrompts[0] ?? "", "SNAPSHOT_BODY_V1"), 0);
      assert.doesNotMatch(resumedPrompts[0] ?? "", /CURRENT_BODY_V2/u);
      assert.equal(currentLibraryLoads, 0, "历史 checkpoint 不应重新读取当前 SkillLibrary");
      assert.equal(resumed.getMessages()[0]?.content, "/demo first request");
      assert.doesNotMatch(
        JSON.stringify(resumed.getMessages()),
        /SNAPSHOT_BODY_V1|explicitSkillCheckpoint|rollHarness/u,
      );
    } finally {
      await resumedEngine?.dispose();
      await firstEngine?.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("context overflow 重试复用同一 checkpoint，Skill 正文只加载和注入一次", async () => {
  let loads = 0;
  let modelCalls = 0;
  const prompts: string[] = [];
  const persisted: ModelMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      modelCalls += 1;
      return streamChunks(modelCalls === 1 ? contextOverflowStep() : textStep("done"));
    },
  });
  const session = new AgentSession({
    id: "explicit-skill-overflow-checkpoint",
    model,
    sources: [],
    maxSteps: 2,
    skillLibrary: demoLibrary("OVERFLOW_SKILL_BODY", () => {
      loads += 1;
    }),
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onPersist: (messages) => persisted.push([...messages]),
  });

  try {
    await drain(session.send("/demo retry"));

    assert.equal(loads, 1);
    assert.equal(prompts.length, 2);
    assert.deepEqual(
      prompts.map((prompt) => occurrences(prompt, "OVERFLOW_SKILL_BODY")),
      [1, 1],
    );
    assert.ok(prompts.every((prompt) => !prompt.includes("rollHarness")));
    assert.equal(occurrences(JSON.stringify(persisted), "explicitSkillCheckpoint"), 1);
    assert.doesNotMatch(JSON.stringify(persisted), /OVERFLOW_SKILL_BODY/u);
    assert.equal(persisted.at(-1)?.[0]?.content, "/demo retry");
  } finally {
    await session.close();
  }
});
