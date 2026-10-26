import assert from "node:assert/strict";
import test from "node:test";
import type { InvocationRecord, ScheduleRecord } from "@roll-agent/runtime";
import * as runtime from "@roll-agent/runtime";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { computeAuthorityDigest } from "./authority.ts";
import type { RollConfig } from "../config/schema.ts";
import { resolveInteractiveChatLlm, type ChatGptAuth } from "../runtime-host/chatgpt-resolution.ts";
import { createChatGptModel } from "../llm/chatgpt-model.ts";
import {
  createScheduledTurnRunner,
  type CreateScheduledTurnRunnerInput,
} from "./run-scheduled-turn.ts";

test("scheduled subscription turn streams Responses, executes local tools and replays their results", async () => {
  const f = scheduledRunnerFixture();
  const previousCwd = process.cwd();
  process.chdir(f.dir);
  const accountId = "25ecece0-b713-4296-8931-a2ea002f3775";
  const marker = "scheduled-tool-marker";
  const path = join(f.dir, "marker.txt");
  writeFileSync(path, marker);
  const config: RollConfig = {
    ...f.config,
    runtime: {
      ...f.config.runtime,
      provider: "chatgpt",
      model: "gpt-6.1-sol",
      chatgptAccountId: accountId,
      thinkingLevel: "low",
      compaction: { ...f.config.runtime.compaction, thinkingLevel: "low" },
    },
  };
  let tokenReads = 0;
  let requests = 0;
  const auth: ChatGptAuth = {
    status: async () => ({
      accounts: [],
      currentAccountId: accountId,
      usageUrl: "https://chatgpt.com/settings/usage",
    }),
    models: async (id) => {
      assert.equal(id, accountId);
      return [
        {
          slug: "gpt-6.1-sol",
          displayName: "Fixture",
          contextWindow: 8192,
          reasoningEfforts: ["low", "high"],
        },
      ];
    },
    getAccessToken: async (id) => {
      assert.equal(id, accountId);
      return `fixture-${++tokenReads}`;
    },
  };
  class IsolatedEngine extends runtime.ConversationEngine {
    constructor(options: ConstructorParameters<typeof runtime.ConversationEngine>[0]) {
      assert.equal(options.provider, "chatgpt");
      assert.equal(options.modelCatalog?.lookup("chatgpt", "gpt-6.1-sol"), 8192);
      assert.deepEqual(options.structuredOutputProviderOptions, {
        openai: { reasoningEffort: "low" },
      });
      const { agentHost: _host, ...isolatedOptions } = options;
      super({ ...isolatedOptions, sources: [], skillLibrary: null, workspaceInstructions: null });
    }
  }
  try {
    const runner = createScheduledTurnRunner({
      config,
      runtime: {
        ...runtime,
        ConversationEngine: IsolatedEngine,
        defaultModelCatalogCachePath: () => join(f.dir, "catalog.json"),
      },
      ledgerDir: f.dir,
      registerThreadReference: (input) =>
        f.store.registerThreadReference({ ...input, ownershipToken: f.token }) !== undefined,
      resolveLlm: async (config) => {
        const selection = await resolveInteractiveChatLlm(config, { auth });
        return {
          ...selection,
          model: createChatGptModel({
            modelId: selection.modelName,
            getAccessToken: () => auth.getAccessToken(selection.accountId),
            fetch: async (_url, init) => {
              const body: unknown = JSON.parse(String(init?.body));
              assert.ok(
                body &&
                  typeof body === "object" &&
                  "stream" in body &&
                  "store" in body &&
                  "reasoning" in body,
              );
              assert.equal(body.stream, true);
              assert.equal(body.store, false);
              assert.deepEqual(body.reasoning, { effort: "low", summary: "detailed" });
              assert.equal("background" in body, false);
              requests++;
              const created = {
                type: "response.created",
                response: { id: `resp-${requests}`, created_at: 1700000000, model: "gpt-6.1-sol" },
              };
              const completed = {
                type: "response.completed",
                response: { status: "completed", usage: { input_tokens: 7, output_tokens: 4 } },
              };
              const tool = {
                type: "function_call",
                id: "function-1",
                call_id: "call-1",
                name: "roll__read_file",
                namespace: "roll",
              };
              const events =
                requests === 1
                  ? [
                      created,
                      {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { ...tool, arguments: "" },
                      },
                      {
                        type: "response.function_call_arguments.delta",
                        item_id: tool.id,
                        output_index: 0,
                        delta: JSON.stringify({ path }),
                      },
                      {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: { ...tool, status: "completed", arguments: JSON.stringify({ path }) },
                      },
                      completed,
                    ]
                  : [
                      created,
                      {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", id: "msg-1" },
                      },
                      {
                        type: "response.output_text.delta",
                        item_id: "msg-1",
                        output_index: 0,
                        delta: marker,
                      },
                      {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: { type: "message", id: "msg-1" },
                      },
                      completed,
                    ];
              if (requests > 1) assert.match(JSON.stringify(body), /scheduled-tool-marker/);
              return new Response(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
                { headers: { "content-type": "text/event-stream" } },
              );
            },
          }),
        };
      },
    });
    const result = await runner(f.schedule, f.invocation);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.status === "completed" ? result.output : "", marker);
    assert.equal(requests, 2);
    assert.equal(tokenReads, 2);
  } finally {
    process.chdir(previousCwd);
    f.close();
  }
});

test("scheduled subscription failure and cancellation cannot fall back to an API-key engine", async () => {
  for (const stop of [false, true]) {
    const f = scheduledRunnerFixture();
    const controller = new AbortController();
    let registered = false;
    try {
      const runner = createScheduledTurnRunner({
        config: f.config,
        runtime,
        ledgerDir: f.dir,
        stopSignal: controller.signal,
        registerThreadReference: () => {
          registered = true;
          return false;
        },
        resolveLlm: async () => {
          if (stop) {
            controller.abort();
            return {
              provider: "chatgpt",
              modelName: "fixture",
              model: new MockLanguageModelV4({}),
              toolSchemaPolicy: () => true,
            };
          }
          throw new Error("subscription_sharing_usage_limit_exceeded");
        },
      });
      if (stop) assert.equal((await runner(f.schedule, f.invocation)).status, "failed");
      else await assert.rejects(runner(f.schedule, f.invocation), /usage_limit_exceeded/);
      assert.equal(registered, false);
    } finally {
      f.close();
    }
  }
});

test("scheduled turn refuses to start when the exec stop signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("scheduled exec stopping"));
  const unavailable = new Proxy(
    {},
    {
      get() {
        throw new Error("aborted scheduled turn must not read runtime/config dependencies");
      },
    },
  );
  const runner = createScheduledTurnRunner({
    config: unavailable as RollConfig,
    runtime: unavailable as CreateScheduledTurnRunnerInput["runtime"],
    ledgerDir: "/unused",
    registerThreadReference: () => {
      throw new Error("must not register after stop");
    },
    stopSignal: controller.signal,
  });

  const result = await runner({} as ScheduleRecord, {} as InvocationRecord);

  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /停止请求/u);
});

test("scheduled turn registers before creating a session and the model sees durable provenance", async () => {
  const f = scheduledRunnerFixture();
  try {
    let called = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        called++;
        const reference = runtime.readScheduleRun(f.dir, f.invocation.id).run?.references[0];
        assert.ok(reference);
        assert.equal(reference.threadsDir, f.config.runtime.threadsDir);
        const source = new runtime.ThreadStore(reference.threadsDir, { readOnly: true });
        try {
          assert.deepEqual(source.getThread(reference.threadId)?.origin, {
            kind: "scheduled",
            scheduleId: f.schedule.id,
            invocationId: f.invocation.id,
            attempt: f.invocation.attempt,
            name: f.schedule.name,
            cwd: f.schedule.cwd,
            scheduledFor: new Date(f.invocation.scheduledForMs).toISOString(),
            ledgerDir: f.dir,
          });
        } finally {
          source.close();
        }
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", delta: "done" },
              { type: "text-end", id: "text" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
    });
    class IsolatedEngine extends runtime.ConversationEngine {
      constructor(options: ConstructorParameters<typeof runtime.ConversationEngine>[0]) {
        assert.equal(runtime.readScheduleRun(f.dir, f.invocation.id).run?.references.length, 1);
        const { agentHost: _host, ...isolatedOptions } = options;
        super({
          ...isolatedOptions,
          model,
          sources: [],
          skillLibrary: null,
          workspaceInstructions: null,
          fileToolsEnabled: false,
        });
      }
    }
    const runner = createScheduledTurnRunner({
      config: f.config,
      runtime: {
        ...runtime,
        ConversationEngine: IsolatedEngine,
        defaultModelCatalogCachePath: () => join(f.dir, "model-cache.json"),
      },
      ledgerDir: f.dir,
      registerThreadReference: (input) =>
        f.store.registerThreadReference({ ...input, ownershipToken: f.token }) !== undefined,
    });
    const result = await runner(f.schedule, f.invocation);
    assert.equal(result.status, "completed");
    assert.equal(called, 1);
    const run = runtime.readScheduleRun(f.dir, f.invocation.id).run;
    assert.equal(result.threadId, run?.references[0]?.threadId);
  } finally {
    f.close();
  }
});

test("lost registration never opens thread storage or constructs the execution engine", async () => {
  const f = scheduledRunnerFixture();
  try {
    class ForbiddenStore extends runtime.ThreadStore {
      constructor() {
        super(assert.fail("must not open thread store"));
      }
    }
    const runner = createScheduledTurnRunner({
      config: f.config,
      runtime: { ...runtime, ThreadStore: ForbiddenStore },
      ledgerDir: f.dir,
      registerThreadReference: () => false,
    });
    const result = await runner(f.schedule, f.invocation);
    assert.equal(result.status, "failed");
    assert.equal(existsSync(f.config.runtime.threadsDir), false);
    assert.equal(runtime.readScheduleRun(f.dir, f.invocation.id).run?.references.length, 0);
  } finally {
    f.close();
  }
});

test("session creation failure preserves the reference without creating a substitute session", async () => {
  const f = scheduledRunnerFixture();
  try {
    class FailingEngine extends runtime.ConversationEngine {
      override async createSession(): Promise<never> {
        throw new Error("creation failed");
      }
    }
    const runner = createScheduledTurnRunner({
      config: f.config,
      runtime: {
        ...runtime,
        ConversationEngine: FailingEngine,
        defaultModelCatalogCachePath: () => join(f.dir, "model-cache.json"),
      },
      ledgerDir: f.dir,
      registerThreadReference: (input) =>
        f.store.registerThreadReference({ ...input, ownershipToken: f.token }) !== undefined,
    });
    await assert.rejects(runner(f.schedule, f.invocation), /creation failed/u);
    const reference = runtime.readScheduleRun(f.dir, f.invocation.id).run?.references[0];
    assert.ok(reference);
    const source = new runtime.ThreadStore(reference.threadsDir, { readOnly: true });
    try {
      assert.equal(source.hasThread(reference.threadId), false);
    } finally {
      source.close();
    }
  } finally {
    f.close();
  }
});

function scheduledRunnerFixture() {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduled-runner-"));
  const config: RollConfig = {
    ...DEFAULT_CONFIG,
    llm: {
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      providers: { openai: { apiKey: "test" } },
    },
    agents: { ...DEFAULT_CONFIG.agents, dataDir: join(dir, "agents") },
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      threadsDir: join(dir, "threads"),
      shell: { ...DEFAULT_CONFIG.runtime.shell, enabled: false },
    },
    scheduler: { ...DEFAULT_CONFIG.scheduler, dataDir: dir },
  };
  const store = new runtime.ScheduleStore(dir);
  const schedule = store.createSchedule({
    name: "来源验证",
    prompt: "检查",
    cwd: "/source/workspace",
    trigger: runtime.createIntervalTrigger("30m"),
    fireImmediately: true,
    authorityDigest: computeAuthorityDigest(config),
  });
  const claim = store.claimDue({ workerId: "test", nowMs: Date.now(), limit: 1 })[0];
  assert.ok(claim);
  const running = store.beginInvocation(claim.invocation.id, claim.ownershipToken);
  assert.ok(running);
  return {
    dir,
    store,
    schedule,
    config,
    invocation: running.invocation,
    token: claim.ownershipToken,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
