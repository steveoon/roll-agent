import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentHost, AgentHostSnapshot } from "../host-contracts/agent-host.ts";
import { runtimeSettingsSchema } from "../host-contracts/runtime-settings.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { ConversationEngine, type ConversationEngineOptions } from "./conversation-engine.ts";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function host(overrides: Partial<AgentHost> = {}): AgentHost {
  return {
    prepare: async () => ({ sources: [] }),
    refresh: async () => {
      throw new Error("refresh unavailable");
    },
    updateSampling: () => {},
    dispose: async () => {},
    ...overrides,
  };
}

function model(text = "done") {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: answer(text),
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}

function answer(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ];
}

function options(extra: Partial<ConversationEngineOptions> = {}): ConversationEngineOptions {
  return {
    settings: runtimeSettingsSchema.parse({ instructions: "off" }),
    model: model(),
    provider: "mock",
    modelName: "fixture",
    workspaceInstructions: null,
    inspectVcsContext: () => undefined,
    fileToolsEnabled: false,
    ...extra,
  };
}

test("engine requires an explicit model and rejects ambiguous source ownership", () => {
  const { model: omitted, ...withoutModel } = options();
  assert.ok(omitted);
  assert.throws(() => Reflect.construct(ConversationEngine, [withoutModel]), /requires a model/);
  assert.throws(
    () => new ConversationEngine(options({ sources: [], agentHost: host() })),
    /either sources or agentHost/,
  );
});

test("an independent engine has no implicit agents or Skills and never disposes caller-owned sources", async () => {
  const engine = new ConversationEngine(options({ sources: [] }));
  assert.deepEqual(await engine.getContextSummary(), {
    agentCount: 0,
    toolCount: 0,
    skillCount: 0,
  });
  const session = await engine.createSession();
  const events = [];
  for await (const event of session.send("hello")) events.push(event);
  assert.ok(events.some((event) => event.type === "message-finish"));
  await engine.dispose();
});

test("dispose waits for a cancelled bootstrap's late result and releases its host once", async () => {
  const started = deferred<AbortSignal>();
  const ready = deferred<AgentHostSnapshot>();
  const order: string[] = [];
  const engine = new ConversationEngine(
    options({
      agentHost: host({
        prepare: async ({ signal }) => {
          started.resolve(signal);
          const snapshot = await ready.promise;
          order.push("settled");
          return snapshot;
        },
        dispose: async () => {
          order.push("disposed");
        },
      }),
    }),
  );
  const creating = assert.rejects(engine.createSession(), /closing/);
  const signal = await started.promise;
  const closing = engine.dispose();
  const closingAgain = engine.dispose();
  assert.equal(signal.aborted, true);
  assert.deepEqual(order, []);
  await assert.rejects(engine.createSession(), /closing/);
  ready.resolve({ sources: [] });
  await Promise.all([creating, closing, closingAgain]);
  assert.deepEqual(order, ["settled", "disposed"]);
});

test("dispose is idempotent even when abort listeners synchronously reenter it", async () => {
  const started = deferred<void>();
  const ready = deferred<AgentHostSnapshot>();
  let reentrant: Promise<void> | undefined;
  let disposals = 0;
  const engine = new ConversationEngine(
    options({
      agentHost: host({
        prepare: async ({ signal }) => {
          signal.addEventListener(
            "abort",
            () => {
              reentrant = engine.dispose();
            },
            { once: true },
          );
          started.resolve();
          return ready.promise;
        },
        dispose: async () => {
          disposals++;
        },
      }),
    }),
  );
  const creating = assert.rejects(engine.createSession(), /closing/);
  await started.promise;
  const closing = engine.dispose();
  ready.resolve({ sources: [] });
  await Promise.all([creating, closing, reentrant]);
  assert.equal(disposals, 1);
});

test("refresh applies serially, discards late results on close and never starts queued refresh work", async () => {
  const started = deferred<AbortSignal>();
  const ready = deferred<void>();
  const names: string[] = [];
  let disposed = 0;
  const engine = new ConversationEngine(
    options({
      agentHost: host({
        refresh: async (name, { signal }) => {
          names.push(name);
          started.resolve(signal);
          await ready.promise;
          return {
            source: {
              agentName: name,
              tools: [],
              client: { callTool: async () => ({ content: [] }) },
            },
          };
        },
        dispose: async () => {
          disposed++;
        },
      }),
    }),
  );
  await engine.createSession();
  const first = assert.rejects(engine.prepareAgentRefresh("first"), /closing/);
  const second = assert.rejects(engine.prepareAgentRefresh("second"), /closing/);
  const signal = await started.promise;
  const closing = engine.dispose();
  assert.equal(signal.aborted, true);
  ready.resolve();
  await Promise.all([first, second, closing]);
  assert.deepEqual(names, ["first"]);
  assert.equal(disposed, 1);
});

test("model switch during bootstrap keeps the final session and Sampling on the newest model", async () => {
  const started = deferred<void>();
  const ready = deferred<AgentHostSnapshot>();
  const sampling: unknown[] = [];
  const next = model("new model");
  const engine = new ConversationEngine(
    options({
      agentHost: host({
        prepare: async () => {
          started.resolve();
          return ready.promise;
        },
        updateSampling: (value) => {
          sampling.push(value);
        },
      }),
    }),
  );
  const creating = engine.createSession();
  await started.promise;
  engine.switchModel({ provider: "next", modelName: "next-model", model: next });
  ready.resolve({ sources: [] });
  const session = await creating;
  for await (const event of session.send("hello")) {
    assert.notEqual(event.type, "error");
  }
  assert.equal(next.doStreamCalls.length, 1);
  assert.equal(sampling.at(-1), next);
  await engine.dispose();
});

test("a busy session rejects model switches before changing Sampling", async () => {
  const started = deferred<void>();
  const ready = deferred<void>();
  let updates = 0;
  const slow = new MockLanguageModelV4({
    doStream: async () => {
      started.resolve();
      await ready.promise;
      return {
        stream: simulateReadableStream({
          chunks: answer("done"),
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const engine = new ConversationEngine(
    options({
      model: slow,
      agentHost: host({
        updateSampling: () => {
          updates++;
        },
      }),
    }),
  );
  const session = await engine.createSession();
  const running = (async () => {
    for await (const event of session.send("hello")) {
      assert.notEqual(event.type, "error");
    }
  })();
  await started.promise;
  const before = updates;
  assert.throws(
    () => engine.switchModel({ provider: "new", modelName: "new", model: model() }),
    /正在生成/,
  );
  assert.equal(updates, before);
  ready.resolve();
  await running;
  await engine.dispose();
});

test("a failed Sampling update preserves the model of live sessions, future sessions and threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-host-model-switch-"));
  const store = new ThreadStore(dir);
  const initial = model("original model");
  const next = model("next model");
  const samplingError = new Error("Sampling update rejected");
  let sampling: LanguageModelV4 = initial;
  const engine = new ConversationEngine(
    options({
      store,
      model: initial,
      agentHost: host({
        updateSampling: (value) => {
          if (value === next) throw samplingError;
          sampling = value;
        },
      }),
    }),
  );
  try {
    const existing = await engine.createSession();
    assert.throws(
      () => engine.switchModel({ provider: "next", modelName: "next-model", model: next }),
      (error) => error === samplingError,
    );
    const future = await engine.createSession();
    for (const session of [existing, future]) {
      assert.equal(store.getThread(session.id)?.model, "fixture");
      for await (const event of session.send("hello")) {
        assert.notEqual(event.type, "error");
      }
    }
    assert.equal(initial.doStreamCalls.length, 2);
    assert.equal(next.doStreamCalls.length, 0);
    assert.equal(sampling, initial);
  } finally {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejected Provider options preserve live sessions, future sessions and Sampling", async () => {
  const initialOptions = { mock: { effort: "low" } };
  const nextOptions = { mock: { effort: "high" } };
  const currentModel = model();
  const samplingError = new Error("Sampling options rejected");
  let sampled: SharedV4ProviderOptions | undefined;
  const engine = new ConversationEngine(
    options({
      model: currentModel,
      providerOptions: initialOptions,
      agentHost: host({
        updateSampling: (_model, providerOptions) => {
          if (providerOptions === nextOptions) throw samplingError;
          sampled = providerOptions;
        },
      }),
    }),
  );
  try {
    const existing = await engine.createSession();
    assert.throws(
      () => existing.setProviderOptions(nextOptions),
      (error) => error === samplingError,
    );
    const future = await engine.createSession();
    for (const session of [existing, future]) {
      for await (const event of session.send("hello")) {
        assert.notEqual(event.type, "error");
      }
    }
    assert.deepEqual(
      currentModel.doStreamCalls.map((call) => call.providerOptions),
      [initialOptions, initialOptions],
    );
    assert.equal(sampled, initialOptions);
  } finally {
    await engine.dispose();
  }
});

test("cleanup preserves all session and host errors and repeat dispose preserves failure", async () => {
  const hostError = new Error("host release failed");
  const sessionError = new Error("session cleanup failed");
  let disposals = 0;
  const engine = new ConversationEngine(
    options({
      agentHost: host({
        dispose: async () => {
          disposals++;
          throw hostError;
        },
      }),
    }),
  );
  const session = await engine.createSession();
  session.close = async () => {
    throw sessionError;
  };
  const check = (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [sessionError, hostError]);
    return true;
  };
  await assert.rejects(engine.dispose(), check);
  await assert.rejects(engine.dispose(), check);
  assert.equal(disposals, 1);
});

test("successful installation remains successful after discovery fails and is not retried", async () => {
  let installs = 0;
  let refreshes = 0;
  const installModel = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks:
          installs === 0
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "install",
                  toolName: "roll__agent_install",
                  input: JSON.stringify({ agent: "demo" }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ]
            : answer("installed"),
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
  const engine = new ConversationEngine(
    options({
      model: installModel,
      hostMode: "interactive",
      agentHost: host({
        prepare: async () => ({
          sources: [],
          catalog: [{ shortName: "demo", description: "demo" }],
        }),
        install: async () => {
          installs++;
          return {
            outcome: { ok: true, agentName: "demo-agent", missingEnv: [], refreshApplied: false },
          };
        },
        refresh: async () => {
          refreshes++;
          throw new Error("discovery failed");
        },
      }),
    }),
  );
  const session = await engine.createSession();
  const results = [];
  for await (const event of session.send("install demo")) {
    if (event.type === "confirmation-required") session.approve(event.approvalId);
    if (event.type === "tool-result") results.push(event);
  }
  assert.equal(installs, 1);
  assert.equal(refreshes, 1);
  assert.equal(results[0]?.isError, false);
  assert.match(JSON.stringify(results[0]?.output), /已安装并注册/);
  assert.match(JSON.stringify(results[0]?.output), /discovery failed/);
  await engine.dispose();
});
