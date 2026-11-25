import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  isThreadEffortToggleEnabled,
  runtimeModelCatalogV16Schema,
  threadModelSetParamsSchema,
  threadModelStatusSchema,
  threadModelStatusV16Schema,
  parseLatestRuntimeMethodParams,
  type RuntimeModelCatalog,
  type RuntimeModelCatalogV16,
  type ThreadEffortLevel,
} from "@roll-agent/protocol";
import { RuntimeService, RuntimeServiceError } from "../service/runtime-service.ts";
import type { AgentHost, AgentHostOperation } from "../host-contracts/agent-host.ts";
import type { SessionOwnershipHost } from "../host-contracts/session-ownership.ts";
import { ModelConfigController } from "../service/model-config-controller.ts";
import { runtimeSettingsSchema } from "../host-contracts/runtime-settings.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { ConversationEngine } from "./conversation-engine.ts";
import {
  ThreadModelEngine,
  ThreadModelError,
  type PreparedThreadModel,
  type ThreadModelHost,
} from "./thread-model-engine.ts";

function streamingModel(
  name: string,
  beforeStream: (options: Parameters<MockLanguageModelV4["doStream"]>[0]) => void | Promise<void>,
) {
  return new MockLanguageModelV4({
    modelId: name,
    doStream: async (options) => {
      await beforeStream(options);
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: name },
            { type: "text-end", id: "text" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
}

function fixture(
  t: TestContext,
  {
    ownership,
    buildHost,
  }: {
    ownership?: SessionOwnershipHost;
    buildHost?: (base: ThreadModelHost) => ThreadModelHost;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "roll-model-engine-"));
  const store = new ThreadStore(dir, ownership ? { ownership } : {});
  const calls: { model: string; options: unknown }[] = [];
  const hosts: { model: string | undefined; disposed: number; updates: number }[] = [];
  let samplingFailure = false;
  let beforeBootstrap: (input: AgentHostOperation) => Promise<void> = async () => {};
  let beforeStream: (name: string) => Promise<void> = async () => {};
  const testCapability = {
    kind: "levels" as const,
    levels: ["low", "medium", "high"] as const,
  };
  const model = (
    name: string,
    effort: "low" | "medium" | "high" = "medium",
  ): PreparedThreadModel => ({
    provider: "test",
    modelName: name,
    effort,
    effortCapability: testCapability,
    providerOptions: { test: { choice: name, effort } },
    reasoning: name === "a" ? "summary" : "text",
    model: streamingModel(name, async (options) => {
      calls.push({ model: name, options });
      await beforeStream(name);
    }),
  });
  let catalog: RuntimeModelCatalog = {
    configRevision: "config-1",
    defaultModel: { provider: "test", model: "a" },
    defaultEffort: "medium",
    items: ["a", "b"].map((name) => ({
      provider: "test",
      model: name,
      available: true,
      effortCapability: testCapability,
    })),
  };
  let prepare: ThreadModelHost["prepare"] = async (identity, _signal, effort) =>
    model(identity.model, effort === "low" || effort === "high" ? effort : "medium");
  const host = {
    catalog: (): RuntimeModelCatalog => catalog,
    prepare: (
      identity: RuntimeModelCatalog["defaultModel"],
      signal: AbortSignal,
      effort?: ThreadEffortLevel,
    ) => prepare(identity, signal, effort),
  } satisfies ThreadModelHost;
  const engine = new ThreadModelEngine({
    initial: model("a"),
    host: buildHost?.(host) ?? host,
    createEngine: (selection, lifecycle) => {
      const tracked = { model: undefined as string | undefined, disposed: 0, updates: 0 };
      hosts.push(tracked);
      const agentHost: AgentHost = {
        prepare: async (input) => {
          await beforeBootstrap(input);
          tracked.model = input.model.modelId;
          return { sources: [] };
        },
        refresh: async () => {
          throw new Error("unused");
        },
        updateSampling: (model) => {
          tracked.updates++;
          if (samplingFailure && model.modelId === "b") throw new Error("private host failure");
          tracked.model = model.modelId;
        },
        dispose: async () => {
          tracked.disposed += 1;
        },
      };
      return new ConversationEngine({
        ...selection,
        ...lifecycle,
        settings: runtimeSettingsSchema.parse({ shell: { enabled: false } }),
        store,
        agentHost,
        skillLibrary: null,
        workspaceInstructions: null,
        fileToolsEnabled: false,
      });
    },
  });
  t.after(async () => {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    engine,
    store,
    calls,
    hosts,
    model,
    host,
    setBeforeBootstrap: (next: typeof beforeBootstrap) => {
      beforeBootstrap = next;
    },
    setSamplingFailure: (failed: boolean) => {
      samplingFailure = failed;
    },
    setPrepare: (next: ThreadModelHost["prepare"]) => {
      prepare = next;
    },
    setCatalog: (next: RuntimeModelCatalog) => {
      catalog = next;
    },
    setBeforeStream: (next: typeof beforeStream) => {
      beforeStream = next;
    },
  };
}

function request(engine: ThreadModelEngine, id: string, name?: string) {
  return threadModelSetParamsSchema.parse({
    requestId: randomUUID(),
    threadId: id,
    expectedRevision: engine.getThreadModel(id).revision,
    configRevision: engine.getModelCatalog().configRevision,
    selection: name ? { mode: "explicit", provider: "test", model: name } : { mode: "default" },
  });
}
async function drain(events: AsyncIterable<unknown>) {
  const iterator = events[Symbol.asyncIterator]();
  while ((await iterator.next()).done !== true) {
    /* consume */
  }
}

test("a rejected model request never reopens a detached session or acquires its ownership", async (t) => {
  const ownership: SessionOwnershipHost = {
    identity: "model-runtime",
    owner: { kind: "test", label: "model-runtime" },
    probe: () => "alive",
  };
  const f = fixture(t, { ownership });
  const service = new RuntimeService(f.engine, f.store);
  const { thread } = await service.createThread(
    parseLatestRuntimeMethodParams("thread.create", { requestId: randomUUID() }),
  );
  const stale = request(f.engine, thread.id, "b");
  await service.detachThread(
    parseLatestRuntimeMethodParams("thread.detach", {
      requestId: randomUUID(),
      threadId: thread.id,
    }),
  );
  try {
    for (const params of [
      stale,
      { ...stale, requestId: randomUUID(), configRevision: "stale" },
      {
        ...stale,
        requestId: randomUUID(),
        selection: { mode: "explicit", provider: "test", model: "missing" } as const,
      },
    ]) {
      await assert.rejects(
        service.setThreadModel(threadModelSetParamsSchema.parse(params)),
        /尚未打开|关闭/u,
      );
      assert.throws(() => service.getThreadModel({ threadId: thread.id }), /尚未打开|关闭/u);
      assert.equal(f.hosts.length, 1);
      assert.equal(f.store.inspectSessionOccupancy(thread.id).status, "available");
    }
    const peer = new ThreadStore(f.dir, { ownership: { ...ownership, identity: "peer" } });
    try {
      const claim = peer.retainThread(thread.id);
      assert.ok(claim);
      claim.release();
    } finally {
      peer.close();
    }
    await service.openThread({ threadId: thread.id });
    await assert.rejects(
      service.setThreadModel(
        threadModelSetParamsSchema.parse({ ...stale, requestId: randomUUID() }),
      ),
      /revision-conflict/u,
    );
    assert.equal(
      (await service.setThreadModel(request(f.engine, thread.id, "b"))).status,
      "applied",
    );
  } finally {
    await service.close();
  }
});

for (const phase of ["prepare", "apply"] as const) {
  test(`default model reload propagates ${phase} failure and recovers after a valid reload`, async (t) => {
    const f = fixture(t);
    const session = await f.engine.createSession();
    const controller = new ModelConfigController({
      isBusy: () => false,
      host: {
        initial: { provider: "test", model: "a" },
        async reload() {
          await f.engine.reloadModelHost(f.host, f.model("b"));
          return { status: "applied", model: { provider: "test", model: "b" } };
        },
      },
    });
    t.after(() => controller.close());
    f.setCatalog({
      ...f.host.catalog(),
      configRevision: "config-2",
      defaultModel: { provider: "test", model: "b" },
    });
    if (phase === "prepare") {
      f.setPrepare(async () => {
        throw new Error("private failure");
      });
    } else f.setSamplingFailure(true);
    controller.reload();
    assert.equal((await controller.whenSettled()).status, "failed");
    assert.equal(f.engine.getThreadModel(session.id).status, "failed");
    await assert.rejects(drain(session.send("blocked")), ThreadModelError);
    f.setPrepare(async (identity) => f.model(identity.model));
    f.setSamplingFailure(false);
    controller.reload();
    assert.equal((await controller.whenSettled()).status, "applied");
    await drain(session.send("recovered"));
    assert.equal(f.calls.at(-1)?.model, "b");
  });
}

test("reload waits for an opening session, and open joins superseding model preparation", async (t) => {
  const f = fixture(t);
  const bootstrapping = Promise.withResolvers<void>();
  const bootstrap = Promise.withResolvers<void>();
  const preparing = Promise.withResolvers<void>();
  const preparation = Promise.withResolvers<void>();
  f.setBeforeBootstrap(async () => {
    bootstrapping.resolve();
    await bootstrap.promise;
  });
  const id = randomUUID();
  let opened = false;
  const opening = f.engine.createSession({ id }).then((session) => {
    opened = true;
    return session;
  });
  await bootstrapping.promise;
  f.setCatalog({
    ...f.host.catalog(),
    configRevision: "config-2",
    defaultModel: { provider: "test", model: "b" },
  });
  f.setPrepare(async (identity, signal) => {
    if (identity.model === "b") {
      preparing.resolve();
      await Promise.race([
        preparation.promise,
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      ]);
    }
    return f.model(identity.model);
  });
  let reloaded = false;
  const reload = f.engine.reloadModelHost(f.host, f.model("b")).then(() => {
    reloaded = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const returnedDuringBootstrap = reloaded;
  bootstrap.resolve();
  await preparing.promise;
  f.setCatalog({ ...f.host.catalog(), configRevision: "config-3" });
  const newerReload = f.engine.reloadModelHost(f.host, f.model("b"));
  // Release the superseded operation while its replacement is still pending.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const returnedDuringPreparation = opened;
  preparation.resolve();
  const [session] = await Promise.all([opening, reload, newerReload]);
  assert.equal(returnedDuringBootstrap, false);
  assert.equal(returnedDuringPreparation, false);
  assert.equal(f.engine.getThreadModel(id).status, "applied");
  assert.equal(f.engine.getThreadModel(id).configRevision, "config-3");
  await drain(session.send("latest configuration"));
  assert.equal(f.calls.at(-1)?.model, "b");
});

test("opening an unchanged initial model does not prepare and switch it a second time", async (t) => {
  const f = fixture(t);
  let prepares = 0;
  f.setPrepare(async (identity) => {
    prepares++;
    return f.model(identity.model);
  });
  const session = await f.engine.createSession();
  assert.equal(prepares, 0);
  assert.equal(f.hosts[0]?.updates, 1, "only the child's initial Sampling setup is needed");
  await drain(session.send("initial model"));
  assert.equal(f.calls.at(-1)?.model, "a");
});

test("two conversations own independent models, options and Sampling without persisting selection across reopen", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  const b = await f.engine.createSession();
  assert.equal((await f.engine.setThreadModel(request(f.engine, a.id, "b"))).status, "applied");
  assert.equal(f.engine.getThreadModel(b.id).active?.model, "a");
  assert.deepEqual(
    f.hosts.map((host) => host.model),
    ["b", "a"],
  );
  await drain(a.send("first a"));
  await drain(b.send("first b"));
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ["b", "a"],
  );
  assert.equal(f.engine.getThreadModel(a.id).active?.reasoning, "text");
  assert.equal(f.engine.getThreadModel(b.id).active?.reasoning, "summary");
  const staleRequest = request(f.engine, a.id, "b");
  await a.close();
  assert.equal(f.hosts[0]?.disposed, 1);
  assert.equal(f.hosts[1]?.disposed, 0);
  const reopened = await f.engine.resumeSession(a.id);
  assert.equal(f.engine.getThreadModel(a.id).active?.model, "a");
  await assert.rejects(f.engine.setThreadModel(staleRequest), /revision-conflict/u);
  await drain(reopened.send("second a"));
  assert.equal(f.calls.at(-1)?.model, "a");
  assert.equal(f.store.getMessages(a.id).filter((message) => message.role === "user").length, 2);
  assert.equal(f.store.getThread(a.id)?.model, "a", "switching never writes a historical label");
});

test("accepted busy selection blocks its own next turn and applies only after settlement", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  const b = await f.engine.createSession();
  let busy = true;
  f.engine.setModelBusyCheck((id) => id === a.id && busy);
  assert.equal((await f.engine.setThreadModel(request(f.engine, a.id, "b"))).status, "pending");
  assert.equal(f.engine.getThreadModel(a.id).active?.model, "a");
  await assert.rejects(drain(a.send("blocked")), ThreadModelError);
  await drain(b.send("other thread"));
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ["a"],
  );
  busy = false;
  await f.engine.settleThreadModel(a.id);
  await drain(a.send("new model"));
  assert.equal(f.calls.at(-1)?.model, "b");
});

test("superseded async preparation cannot overwrite a newer selection", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setPrepare(async (identity) => {
    if (identity.model === "b") await delayed;
    return f.model(identity.model);
  });
  const stale = f.engine.setThreadModel(request(f.engine, a.id, "b"));
  await f.engine.setThreadModel(request(f.engine, a.id));
  release();
  await stale;
  assert.equal(f.engine.getThreadModel(a.id).active?.model, "a");
  assert.deepEqual(f.engine.getThreadModel(a.id).selection, { mode: "default" });
});

test("removed explicit model fails closed and follow-default recovers the same thread", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  await f.engine.setThreadModel(request(f.engine, a.id, "b"));
  f.setCatalog({
    configRevision: "config-2",
    defaultModel: { provider: "test", model: "a" },
    defaultEffort: "medium",
    items: [
      {
        provider: "test",
        model: "a",
        available: true,
        effortCapability: { kind: "levels", levels: ["low", "medium", "high"] },
      },
    ],
  });
  await f.engine.reloadModelHost(f.host, f.model("a"));
  assert.equal(f.engine.getThreadModel(a.id).status, "failed");
  await assert.rejects(drain(a.send("blocked")), ThreadModelError);
  assert.equal((await f.engine.setThreadModel(request(f.engine, a.id))).status, "applied");
  await drain(a.send("recovered"));
  assert.equal(f.calls.at(-1)?.model, "a");
});

test("restoring a removed model via reload clears failure fields from the public status", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  await f.engine.setThreadModel(request(f.engine, a.id, "b"));
  const original = f.host.catalog();
  f.setCatalog({
    ...original,
    configRevision: "removed",
    items: original.items.filter((item) => item.model !== "b"),
  });
  await f.engine.reloadModelHost(f.host, f.model("a"));
  threadModelStatusSchema.parse(f.engine.getThreadModel(a.id));
  f.setCatalog({ ...original, configRevision: "restored" });
  await f.engine.reloadModelHost(f.host, f.model("a"));
  const status = threadModelStatusSchema.parse(f.engine.getThreadModel(a.id));
  assert.equal(status.status, "applied");
  assert.equal(status.active?.model, "b");
  assert.equal("reason" in status, false);
});

test("close aborts preparation and stale configuration or revision never mutates active state", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  await assert.rejects(
    f.engine.setThreadModel({ ...request(f.engine, a.id, "b"), configRevision: "old" }),
    /config-changed/u,
  );
  await assert.rejects(
    f.engine.setThreadModel({ ...request(f.engine, a.id, "b"), expectedRevision: randomUUID() }),
    /revision-conflict/u,
  );
  assert.deepEqual(f.engine.getThreadModel(a.id).selection, { mode: "default" });
  let aborted = false;
  const preparing = Promise.withResolvers<void>();
  f.setPrepare(
    async (_identity, signal) =>
      new Promise((_resolve, reject) => {
        preparing.resolve();
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  const pending = f.engine.setThreadModel(request(f.engine, a.id, "b"));
  const rejected = assert.rejects(pending, /unavailable/u);
  await preparing.promise;
  await a.close();
  await rejected;
  assert.equal(aborted, true);
  assert.throws(() => f.engine.getThreadModel(a.id), /unavailable/u);
  assert.equal(f.store.getThread(a.id)?.model, "a");
});

test("failed projection cannot be repaired by another model selection", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  f.engine.failThreadModelSettlement(a.id);
  assert.equal((await f.engine.setThreadModel(request(f.engine, a.id, "b"))).status, "failed");
  await assert.rejects(drain(a.send("blocked")), ThreadModelError);
});

test("RuntimeService defers a real running turn, permits another thread and enforces idempotency", async (t) => {
  const f = fixture(t);
  const service = new RuntimeService(f.engine, f.store);
  const a = await f.engine.createSession();
  const b = await f.engine.createSession();
  let release = () => {};
  let entered = () => {};
  const streaming = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setBeforeStream(async () => {
    entered();
    await barrier;
  });
  await service.startTurn(
    parseLatestRuntimeMethodParams("turn.start", {
      requestId: randomUUID(),
      threadId: a.id,
      turnId: randomUUID(),
      input: { text: "old model turn" },
    }),
  );
  await streaming;
  const params = request(f.engine, a.id, "b");
  const pending = await service.setThreadModel(params);
  assert.equal(pending.status, "pending");
  assert.equal(pending.active?.model, "a");
  assert.deepEqual(await service.setThreadModel(params), pending);
  assert.throws(
    () => service.setThreadModel({ ...params, selection: { mode: "default" } }),
    RuntimeServiceError,
  );
  await service.openThread(parseLatestRuntimeMethodParams("thread.open", { threadId: b.id }));
  assert.equal((await service.setThreadModel(request(f.engine, b.id, "b"))).status, "applied");
  release();
  for (let i = 0; i < 100 && f.engine.getThreadModel(a.id).status !== "applied"; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.engine.getThreadModel(a.id).active?.model, "b");
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ["a"],
  );
  await service.startTurn(
    parseLatestRuntimeMethodParams("turn.start", {
      requestId: randomUUID(),
      threadId: a.id,
      turnId: randomUUID(),
      input: { text: "new model turn" },
    }),
  );
  await service.close();
});

test("concurrent close cancels opening host bootstrap", async (t) => {
  const f = fixture(t);
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  f.setBeforeBootstrap(
    async ({ signal }) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("abort"));
          },
          { once: true },
        );
      }),
  );
  const opening = f.engine.createSession();
  await started;
  const rejected = assert.rejects(opening, /abort|unavailable/u);
  await f.engine.dispose();
  await rejected;
  assert.equal(aborted, true);
});

for (const phase of ["prepare", "apply"] as const) {
  test(`${phase} failure blocks execution without changing the active model and remains repairable`, async (t) => {
    const f = fixture(t);
    const session = await f.engine.createSession();
    await drain(session.send("before failure"));
    if (phase === "prepare") {
      f.setPrepare(async () => {
        throw new Error("credential=private");
      });
    } else {
      f.setSamplingFailure(true);
    }
    const failed = await f.engine.setThreadModel(request(f.engine, session.id, "b"));
    assert.equal(failed.status, "failed");
    assert.equal(failed.active?.model, "a");
    assert.doesNotMatch(JSON.stringify(failed), /credential|private/u);
    await assert.rejects(drain(session.send("must not use previous model")), ThreadModelError);
    assert.equal(f.calls.length, 1);
    assert.equal(f.hosts[0]?.model, "a");
    f.setPrepare(async (identity) => f.model(identity.model));
    f.setSamplingFailure(false);
    assert.equal(
      (await f.engine.setThreadModel(request(f.engine, session.id, "b"))).status,
      "applied",
    );
    await drain(session.send("after repair"));
    assert.deepEqual(
      f.calls.map((call) => call.model),
      ["a", "b"],
    );
    assert.equal(f.store.getMessages(session.id).filter((m) => m.role === "user").length, 2);
  });
}

test("superseded concurrent mutation returns its own accepted pending snapshot and caches its own response", async (t) => {
  const f = fixture(t);
  const service = new RuntimeService(f.engine, f.store);
  try {
    const { thread } = await service.createThread(
      parseLatestRuntimeMethodParams("thread.create", { requestId: randomUUID() }),
    );
    const enteredPrepareB = Promise.withResolvers<void>();
    const releasePrepareB = Promise.withResolvers<void>();
    f.setPrepare(async (identity, _signal, effort) => {
      if (identity.model === "b") {
        enteredPrepareB.resolve();
        await releasePrepareB.promise;
      }
      return f.model(identity.model, effort === "low" || effort === "high" ? effort : "medium");
    });

    const initial = service.getThreadModel({ threadId: thread.id });
    const reqA = threadModelSetParamsSchema.parse({
      requestId: randomUUID(),
      threadId: thread.id,
      expectedRevision: initial.revision,
      configRevision: initial.configRevision,
      selection: { mode: "explicit", provider: "test", model: "b" },
      effort: { mode: "explicit", level: "high" },
    });
    const pendingCallA = service.setThreadModel(reqA);
    await enteredPrepareB.promise;

    const observedPending = threadModelStatusSchema.parse(
      service.getThreadModel({ threadId: thread.id }),
    );
    assert.equal(observedPending.status, "pending");
    assert.equal(observedPending.target.model, "b");
    assert.equal(observedPending.target.effectiveEffort, "high");

    const reqB = threadModelSetParamsSchema.parse({
      requestId: randomUUID(),
      threadId: thread.id,
      expectedRevision: observedPending.revision,
      configRevision: observedPending.configRevision,
      selection: { mode: "explicit", provider: "test", model: "a" },
      effort: { mode: "explicit", level: "low" },
    });
    const resultB = threadModelStatusSchema.parse(await service.setThreadModel(reqB));
    releasePrepareB.resolve();
    const resultA = threadModelStatusSchema.parse(await pendingCallA);

    assert.equal(resultA.revision, observedPending.revision);
    assert.equal(resultA.status, "pending");
    assert.equal(resultA.target.model, "b");
    assert.equal(resultA.target.effectiveEffort, "high");

    assert.notEqual(resultB.revision, resultA.revision);
    assert.equal(resultB.status, "applied");
    assert.equal(resultB.target.model, "a");
    assert.equal(resultB.target.effectiveEffort, "low");
    assert.equal(resultB.active?.model, "a");
    assert.equal(resultB.active?.effort, "low");

    // Retrying reqA with the same requestId must return reqA's own cached snapshot, never B's.
    assert.deepEqual(await service.setThreadModel(reqA), resultA);
    assert.deepEqual(service.getThreadModel({ threadId: thread.id }), resultB);
  } finally {
    await service.close();
  }
});

test("rejected invalid effort or default combination never consumes revision or replaces an existing pending selection", async (t) => {
  const f = fixture(t);
  const a = await f.engine.createSession();
  let busy = true;
  f.engine.setModelBusyCheck((id) => id === a.id && busy);

  const validPending = threadModelStatusSchema.parse(
    await f.engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: a.id,
        expectedRevision: f.engine.getThreadModel(a.id).revision,
        configRevision: f.engine.getModelCatalog().configRevision,
        selection: { mode: "explicit", provider: "test", model: "b" },
        effort: { mode: "explicit", level: "high" },
      }),
    ),
  );
  assert.equal(validPending.status, "pending");
  assert.equal(validPending.active?.effort, "medium");
  assert.equal(validPending.target.model, "b");
  assert.equal(validPending.target.effectiveEffort, "high");

  await assert.rejects(
    f.engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: a.id,
        expectedRevision: validPending.revision,
        configRevision: validPending.configRevision,
        effort: { mode: "explicit", level: "xhigh" },
      }),
    ),
    (error: unknown) => error instanceof ThreadModelError && error.reason === "effort-unsupported",
  );

  // Also test fallback default validation when global defaultEffort is incompatible with target capability.levels.
  f.setCatalog({
    ...f.host.catalog(),
    defaultEffort: "off",
    items: [
      {
        provider: "test",
        model: "a",
        available: true,
        effortCapability: { kind: "levels", levels: ["off", "low", "medium", "high"] },
      },
      {
        provider: "test",
        model: "b",
        available: true,
        effortCapability: { kind: "levels", levels: ["low", "medium", "high"] },
      },
    ],
  });
  await assert.rejects(
    f.engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: a.id,
        expectedRevision: validPending.revision,
        configRevision: validPending.configRevision,
        selection: { mode: "explicit", provider: "test", model: "b" },
        effort: { mode: "default" },
      }),
    ),
    (error: unknown) => error instanceof ThreadModelError && error.reason === "effort-unsupported",
  );

  // Revision and pending target must remain intact after the rejected write.
  assert.deepEqual(f.engine.getThreadModel(a.id), validPending);

  busy = false;
  await f.engine.settleThreadModel(a.id);
  const settled = threadModelStatusSchema.parse(f.engine.getThreadModel(a.id));
  assert.equal(settled.status, "applied");
  assert.equal(settled.active?.model, "b");
  assert.equal(settled.active?.effort, "high");
});

test("same-model effort updates use the host receiver and propagate to Sampling and the next turn", async (t) => {
  let effortUpdates = 0;
  class EffortHost implements ThreadModelHost {
    readonly #capability = { kind: "levels", levels: ["low", "medium", "high"] } as const;
    readonly catalog: ThreadModelHost["catalog"];
    constructor(base: ThreadModelHost) {
      this.catalog = base.catalog;
    }
    async prepare(): Promise<PreparedThreadModel> {
      throw new Error("unexpected full model preparation");
    }
    prepareEffort(current: Pick<PreparedThreadModel, "modelName">, effort: ThreadEffortLevel) {
      effortUpdates++;
      return {
        effort,
        effortCapability: this.#capability,
        providerOptions: { test: { choice: current.modelName, effort } },
        reasoning: effort === "high" ? ("text" as const) : ("summary" as const),
      };
    }
  }
  const f = fixture(t, { buildHost: (base) => new EffortHost(base) });

  const session = await f.engine.createSession();
  await drain(session.send("calibrate budget"));
  assert.equal(effortUpdates, 0);

  const updated = threadModelStatusSchema.parse(
    await f.engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: session.id,
        expectedRevision: f.engine.getThreadModel(session.id).revision,
        configRevision: f.engine.getModelCatalog().configRevision,
        effort: { mode: "explicit", level: "high" },
      }),
    ),
  );
  assert.equal(effortUpdates, 1);
  assert.equal(updated.status, "applied");
  assert.deepEqual(updated.selection, { mode: "default" });
  assert.equal(updated.active?.effort, "high");
  assert.equal(updated.active?.reasoning, "text");
  assert.equal(f.engine.hasThreadReasoning("text"), true);
  assert.equal(f.hosts[0]?.updates, 2, "initial Sampling + lightweight setProviderOptions update");

  await drain(session.send("turn with high effort"));
  const lastOptions = f.calls.at(-1)?.options;
  assert.ok(
    typeof lastOptions === "object" && lastOptions !== null && "providerOptions" in lastOptions,
  );
  assert.deepEqual(lastOptions.providerOptions, { test: { choice: "a", effort: "high" } });
});

function createHostEngine(t: TestContext, initial: PreparedThreadModel, host: ThreadModelHost) {
  const dir = mkdtempSync(join(tmpdir(), "roll-model-host-"));
  const store = new ThreadStore(dir);
  const engine = new ThreadModelEngine({
    initial,
    host,
    createEngine: (selection, lifecycle) =>
      new ConversationEngine({
        ...selection,
        ...lifecycle,
        settings: runtimeSettingsSchema.parse({ shell: { enabled: false } }),
        store,
        sources: [],
        skillLibrary: null,
        workspaceInstructions: null,
        fileToolsEnabled: false,
      }),
  });
  t.after(async () => {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return engine;
}

test("legacy 1.6 ThreadModelHost remains compatible, degrades honestly without fabricating effort, and switches models", async (t) => {
  const calls: string[] = [];
  const prepareArgCounts: number[] = [];
  const makeLegacyPrepared = (name: string): PreparedThreadModel => ({
    provider: "legacy",
    modelName: name,
    reasoning: "summary",
    model: streamingModel(name, () => {
      calls.push(name);
    }),
  });
  const legacyCatalog: RuntimeModelCatalogV16 = {
    configRevision: "legacy-cfg-1",
    defaultModel: { provider: "legacy", model: "a" },
    items: [
      { provider: "legacy", model: "a", available: true },
      { provider: "legacy", model: "b", available: true },
    ],
  };
  const legacyHost: ThreadModelHost = {
    catalog: () => legacyCatalog,
    prepare: async function prepareLegacy(identity, signal) {
      prepareArgCounts.push(arguments.length);
      signal.throwIfAborted();
      return makeLegacyPrepared(identity.model);
    },
  };
  const engine = createHostEngine(t, makeLegacyPrepared("a"), legacyHost);

  assert.equal(engine.supportsThreadEffort(), false);
  const catalog = runtimeModelCatalogV16Schema.parse(engine.getModelCatalog());
  assert.equal("defaultEffort" in catalog, false);
  assert.equal("effortCapability" in catalog.items[0]!, false);

  const session = await engine.createSession();
  const initialStatus = threadModelStatusV16Schema.parse(engine.getThreadModel(session.id));
  assert.equal(initialStatus.status, "applied");
  assert.equal(initialStatus.active.model, "a");
  assert.equal("target" in initialStatus, false);
  assert.equal("effort" in initialStatus, false);
  assert.equal("effort" in initialStatus.active, false);

  // Explicit effort or effort-only writes must fail without changing revision/state.
  await assert.rejects(
    engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: session.id,
        expectedRevision: initialStatus.revision,
        configRevision: initialStatus.configRevision,
        effort: { mode: "explicit", level: "high" },
      }),
    ),
    (error: unknown) => error instanceof ThreadModelError && error.reason === "effort-unsupported",
  );
  assert.deepEqual(engine.getThreadModel(session.id), initialStatus);

  // Ordinary 1.6 model switch must work and pass only (identity, signal) to legacy prepare().
  const switched = threadModelStatusV16Schema.parse(
    await engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: session.id,
        expectedRevision: initialStatus.revision,
        configRevision: initialStatus.configRevision,
        selection: { mode: "explicit", provider: "legacy", model: "b" },
      }),
    ),
  );
  assert.equal(switched.status, "applied");
  assert.equal(switched.active.model, "b");
  assert.deepEqual(prepareArgCounts, [2]);

  await drain(session.send("ping legacy switch"));
  assert.deepEqual(calls, ["b"]);
});

test("defaultValidateTarget enforces explicit toggle bounds while allowing host default restore", async (t) => {
  const toggleCapability = { kind: "toggle", offLevel: "off", onLevel: "medium" } as const;
  const buildModel = (modelName: string, effort: ThreadEffortLevel): PreparedThreadModel => ({
    provider: "test",
    modelName,
    effort,
    effortCapability: toggleCapability,
    providerOptions: { test: { effort } },
    reasoning: "summary",
    model: new MockLanguageModelV4({ modelId: modelName }),
  });
  const catalog: RuntimeModelCatalog = {
    configRevision: "toggle-cfg-1",
    defaultModel: { provider: "test", model: "a" },
    defaultEffort: "high",
    items: [
      {
        provider: "test",
        model: "a",
        available: true,
        effortCapability: toggleCapability,
      },
    ],
  };
  const host: ThreadModelHost = {
    catalog: () => catalog,
    prepare: async (identity, _signal, effort) => buildModel(identity.model, effort ?? "high"),
  };
  const engine = createHostEngine(t, buildModel("a", "high"), host);

  const session = await engine.createSession();
  const initial = threadModelStatusSchema.parse(engine.getThreadModel(session.id));
  assert.equal(initial.status, "applied");
  assert.equal(initial.active.effort, "high");
  assert.equal(isThreadEffortToggleEnabled(toggleCapability, initial.active.effort), true);

  await assert.rejects(
    engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: session.id,
        expectedRevision: initial.revision,
        configRevision: initial.configRevision,
        effort: { mode: "explicit", level: "xhigh" },
      }),
    ),
    (error: unknown) => error instanceof ThreadModelError && error.reason === "effort-unsupported",
  );
  assert.deepEqual(engine.getThreadModel(session.id), initial);

  const toggledOff = threadModelStatusSchema.parse(
    await engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: session.id,
        expectedRevision: initial.revision,
        configRevision: initial.configRevision,
        effort: { mode: "explicit", level: "off" },
      }),
    ),
  );
  assert.equal(toggledOff.status, "applied");
  assert.equal(toggledOff.active.effort, "off");
  assert.equal(isThreadEffortToggleEnabled(toggleCapability, toggledOff.active.effort), false);

  const restoredDefault = threadModelStatusSchema.parse(
    await engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: session.id,
        expectedRevision: toggledOff.revision,
        configRevision: toggledOff.configRevision,
        effort: { mode: "default" },
      }),
    ),
  );
  assert.equal(restoredDefault.status, "applied");
  assert.equal(restoredDefault.effort.mode, "default");
  assert.equal(restoredDefault.active.effort, "high");
  assert.equal(isThreadEffortToggleEnabled(toggleCapability, restoredDefault.active.effort), true);

  const toggledOn = threadModelStatusSchema.parse(
    await engine.setThreadModel(
      threadModelSetParamsSchema.parse({
        requestId: randomUUID(),
        threadId: session.id,
        expectedRevision: restoredDefault.revision,
        configRevision: restoredDefault.configRevision,
        effort: { mode: "explicit", level: "medium" },
      }),
    ),
  );
  assert.equal(toggledOn.status, "applied");
  assert.equal(toggledOn.active.effort, "medium");
  assert.equal(isThreadEffortToggleEnabled(toggleCapability, toggledOn.active.effort), true);
});
