import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { runtimeMethodSchemas, type RuntimeEventEnvelopeV16 } from "@roll-agent/protocol";
import { AgentSession } from "../engine/agent-session.ts";
import { SessionClaims, SessionOccupiedError } from "./session-claims.ts";
import { ConversationEngine } from "../engine/conversation-engine.ts";
import { runtimeSettingsSchema } from "../host-contracts/runtime-settings.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { RuntimeService } from "../service/runtime-service.ts";
import { AttachmentStore } from "../service/attachment-store.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function response(text = "reply") {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks: [
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: text },
        { type: "text-end", id: "text" },
        { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}
function deferred() {
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}
async function drain(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const value of stream) events.push(value);
  return events;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(
  model = new MockLanguageModelV4({ doStream: async () => response() }),
  strategy = "truncate",
) {
  const dir = mkdtempSync(join(tmpdir(), "roll-lifecycle-"));
  const stores = ["first", "second"].map(
    (identity) =>
      new ThreadStore(dir, {
        ownership: { identity, owner: { kind: "test", label: identity }, probe: () => "alive" },
      }),
  );
  const first = stores[0]!;
  const second = stores[1]!;
  const engine = (store: ThreadStore) =>
    new ConversationEngine({
      store,
      model,
      provider: "mock",
      modelName: "fixture",
      settings: runtimeSettingsSchema.parse({
        compaction: { enabled: false, strategy, keepRecentTurns: 1, keepRecentTokens: 1 },
      }),
      sources: [],
      skillLibrary: null,
      workspaceInstructions: null,
      fileToolsEnabled: false,
      sessionExecEnabled: false,
    });
  const a = engine(first);
  const b = engine(second);
  return {
    dir,
    first,
    second,
    a,
    b,
    async close() {
      await a.dispose();
      await b.dispose();
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("coalesced resume and close barriers reject stale cached sessions until authoritative reopen", async () => {
  const f = setup();
  try {
    const id = f.first.createThread();
    const [one, two] = await Promise.all([f.a.resumeSession(id), f.a.resumeSession(id)]);
    assert.equal(one, two);
    await assert.rejects(f.b.resumeSession(id), SessionOccupiedError);
    const barrier = deferred();
    one.addCloseBarrier(() => barrier.promise);
    const closing = one.close();
    assert.equal(one.close(), closing);
    let settled = false;
    closing.then(() => {
      settled = true;
    });
    await tick();
    assert.equal(settled, false);
    await assert.rejects(f.a.resumeSession(id), /closing/);
    await assert.rejects(f.b.resumeSession(id), SessionOccupiedError);
    barrier.resolve();
    await closing;
    const next = await f.b.resumeSession(id);
    await drain(next.send("persist across owner transition"));
    await next.close();
    const reopened = await f.a.resumeSession(id);
    assert.ok(JSON.stringify(reopened.getMessages()).includes("persist across owner transition"));
    await assert.rejects(drain(one.send("stale")), /closed/);
  } finally {
    await f.close();
  }
});

function delayProducerCompletion(target: object, method: string) {
  const entered = deferred();
  const release = deferred();
  const original: unknown = Reflect.get(target, method);
  if (typeof original !== "function") throw new Error(`Missing producer ${method}`);
  Object.defineProperty(target, method, {
    value: async (...args: unknown[]) => {
      const result: unknown = await Reflect.apply(original, target, args);
      entered.resolve();
      await release.promise;
      return result;
    },
  });
  return { entered, release };
}

for (const mode of ["turn", "compaction"] as const) {
  test(`close waits for ${mode} producer tail after iterator completion`, async () => {
    const f = setup();
    let pending: ReturnType<typeof delayProducerCompletion> | undefined;
    try {
      const session = await f.a.createSession();
      await drain(session.send("first " + "history".repeat(300)));
      await drain(session.send("second"));
      pending = delayProducerCompletion(session, mode === "turn" ? "runTurn" : "runCompactionTurn");
      const running = drain(mode === "turn" ? session.send("pending") : session.compact());
      await pending.entered.promise;
      await running; // Queue closure is explicitly not producer settlement.
      const closing = session.close();
      let done = false;
      closing.then(() => {
        done = true;
      });
      await tick();
      assert.equal(done, false);
      await assert.rejects(f.b.resumeSession(session.id), SessionOccupiedError);
      pending.release.resolve();
      await closing;
      await f.b.resumeSession(session.id);
    } finally {
      pending?.release.resolve();
      await f.close();
    }
  });
}

test("detach waits for terminal projection even after active turn has disappeared", async () => {
  const f = setup();
  const service = new RuntimeService(f.a, f.first);
  const pending = delayProducerCompletion(service, "driveTurn");
  try {
    const session = await f.a.createSession();
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: randomUUID(),
        threadId: session.id,
        turnId: randomUUID(),
        input: { text: "terminal" },
      }),
    );
    await pending.entered.promise;
    assert.equal(
      service.snapshotThread(
        runtimeMethodSchemas["thread.snapshot"].params.parse({ threadId: session.id, limit: 100 }),
      ).activeTurn,
      undefined,
    );
    const detach = service.detachThread(
      runtimeMethodSchemas["thread.detach"].params.parse({
        requestId: randomUUID(),
        threadId: session.id,
      }),
    );
    let done = false;
    detach.then(() => {
      done = true;
    });
    await tick();
    assert.equal(done, false);
    await assert.rejects(f.b.resumeSession(session.id), SessionOccupiedError);
    await assert.rejects(
      service.openThread(
        runtimeMethodSchemas["thread.open"].params.parse({ threadId: session.id }),
      ),
      /关闭/,
    );
    pending.release.resolve();
    assert.equal((await detach).detached, true);
    const reopened = await f.b.resumeSession(session.id);
    assert.ok(JSON.stringify(reopened.getMessages()).includes("terminal"));
  } finally {
    pending.release.resolve();
    await service.close();
    await f.close();
  }
});

test("service rename/delete/attachments without open cannot bypass another idle owner", async () => {
  const f = setup();
  const attachments = new AttachmentStore({ dir: join(f.dir, "attachments") });
  const service = new RuntimeService(f.b, f.second, { attachmentStore: attachments });
  try {
    const session = await f.a.createSession();
    await assert.rejects(
      service.renameThread(
        runtimeMethodSchemas["thread.rename"].params.parse({
          requestId: randomUUID(),
          threadId: session.id,
          title: "bad",
        }),
      ),
      SessionOccupiedError,
    );
    await assert.rejects(
      service.deleteThread(
        runtimeMethodSchemas["thread.delete"].params.parse({
          requestId: randomUUID(),
          threadId: session.id,
        }),
      ),
      SessionOccupiedError,
    );
    const data = Buffer.from("fixture");
    const sourcePath = join(f.dir, "source.txt");
    writeFileSync(sourcePath, data);
    const stage = () =>
      runtimeMethodSchemas["attachment.stage"].params.parse({
        requestId: randomUUID(),
        threadId: session.id,
        fileName: "source.txt",
        mediaType: "text/plain",
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        source: "local-path",
        sourcePath,
      });
    await assert.rejects(service.stageAttachment(stage()), SessionOccupiedError);
    await session.close();
    const staged = await service.stageAttachment(stage());
    assert.equal(staged.state, "committed");
    await assert.rejects(f.a.resumeSession(session.id), SessionOccupiedError);
    assert.equal(
      (
        await service.detachThread(
          runtimeMethodSchemas["thread.detach"].params.parse({
            requestId: randomUUID(),
            threadId: session.id,
          }),
        )
      ).detached,
      true,
    );
    await f.a.resumeSession(session.id);
  } finally {
    await service.close();
    await f.close();
  }
});

test("different-thread services preserve durable event sequences, attachments and compaction", async () => {
  const f = setup();
  const services = [
    new RuntimeService(f.a, f.first, {
      attachmentStore: new AttachmentStore({ dir: join(f.dir, "attachments") }),
    }),
    new RuntimeService(f.b, f.second, {
      attachmentStore: new AttachmentStore({ dir: join(f.dir, "attachments") }),
    }),
  ];
  try {
    const sessions = await Promise.all([f.a.createSession(), f.b.createSession()]);
    const eventSets: RuntimeEventEnvelopeV16[][] = [[], []];
    for (const [index, service] of services.entries()) {
      service.onEvent((event) => eventSets[index]!.push(event));
    }
    const data = Buffer.from("safe");
    const sourcePath = join(f.dir, "file.txt");
    writeFileSync(sourcePath, data);
    await Promise.all(
      services.map((service, index) =>
        service.stageAttachment(
          runtimeMethodSchemas["attachment.stage"].params.parse({
            requestId: randomUUID(),
            threadId: sessions[index]!.id,
            fileName: "file.txt",
            mediaType: "text/plain",
            bytes: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
            source: "local-path",
            sourcePath,
          }),
        ),
      ),
    );
    for (let round = 0; round < 2; round++) {
      const ended = services.map(
        (service) =>
          new Promise<void>((resolve) => {
            const off = service.onEvent((event) => {
              if (event.event.type === "turn.completed") {
                off();
                resolve();
              }
            });
          }),
      );
      await Promise.all(
        services.map((service, index) =>
          service.startTurn(
            runtimeMethodSchemas["turn.start"].params.parse({
              requestId: randomUUID(),
              threadId: sessions[index]!.id,
              turnId: randomUUID(),
              input: { text: `message ${round} ${"history".repeat(300)}` },
            }),
          ),
        ),
      );
      await Promise.all(ended);
    }
    await Promise.all(sessions.map((session) => drain(session.compact())));
    for (const [index, session] of sessions.entries()) {
      const store = index === 0 ? f.first : f.second;
      const events = store.resumeRuntimeEvents(session.id, null).events;
      assert.ok(events.length >= 4);
      assert.equal(new Set(events.map((event) => event.cursor)).size, events.length);
      assert.ok(store.getLatestCheckpoint(session.id));
    }
  } finally {
    await Promise.all(services.map((service) => service.close()));
    await f.close();
  }
});

test("failed close barrier retains ownership; repeated close shares the rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-failed-close-"));
  const host = (identity: string) => ({
    identity,
    owner: { kind: "test", label: identity },
    probe: () => "alive" as const,
  });
  const a = new SessionClaims(join(dir, "threads.db"), host("a"));
  const b = new SessionClaims(join(dir, "threads.db"), host("b"));
  const claim = a.acquire("fixture");
  const session = new AgentSession({
    id: "fixture",
    model: new MockLanguageModelV4({}),
    sources: [],
    maxSteps: 1,
    onClose: () => claim.release(),
  });
  session.addCloseBarrier(async () => {
    throw new Error("unsettled terminal write");
  });
  try {
    const closing = session.close();
    assert.equal(session.close(), closing);
    await assert.rejects(closing, /unsettled/);
    assert.throws(() => b.acquire("fixture"), SessionOccupiedError);
    claim.assert();
  } finally {
    claim.release();
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two engines sharing the same protected store cannot create duplicate writable sessions", async () => {
  const f = setup();
  const extra = new ConversationEngine({
    store: f.first,
    model: new MockLanguageModelV4({}),
    provider: "mock",
    modelName: "fixture",
    settings: runtimeSettingsSchema.parse({}),
    sources: [],
    skillLibrary: null,
    workspaceInstructions: null,
  });
  try {
    const session = await f.a.createSession();
    await assert.rejects(extra.resumeSession(session.id), SessionOccupiedError);
  } finally {
    await extra.dispose();
    await f.close();
  }
});

test("detach racing a pending open cannot resurrect a closing session", async () => {
  const f = setup();
  const service = new RuntimeService(f.a, f.first);
  const pending = delayProducerCompletion(f.a, "bootstrap");
  try {
    const id = f.first.createThread();
    const open = service.openThread(
      runtimeMethodSchemas["thread.open"].params.parse({ threadId: id }),
    );
    const rejected = assert.rejects(open, /关闭/);
    await pending.entered.promise;
    const detach = service.detachThread(
      runtimeMethodSchemas["thread.detach"].params.parse({ requestId: randomUUID(), threadId: id }),
    );
    await tick();
    await assert.rejects(f.b.resumeSession(id), SessionOccupiedError);
    pending.release.resolve();
    await rejected;
    assert.equal((await detach).detached, true);
    await f.b.resumeSession(id);
  } finally {
    pending.release.resolve();
    await service.close();
    await f.close();
  }
});

test("late protocol callbacks and old close barriers cannot borrow a reopened session claim", async () => {
  const f = setup();
  const service = new RuntimeService(f.a, f.first);
  let staleEvent: (() => void) | undefined;
  let staleClose: (() => Promise<void>) | undefined;
  const emit: unknown = Reflect.get(service, "emit");
  assert.equal(typeof emit, "function");
  Reflect.set(service, "emit", function (...args: unknown[]) {
    if (typeof emit !== "function") throw new Error("missing emitter");
    staleEvent ??= () => Reflect.apply(emit, service, args);
    return Reflect.apply(emit, service, args);
  });
  try {
    const session = await f.a.createSession();
    const addBarrier = session.addCloseBarrier.bind(session);
    session.addCloseBarrier = (barrier) => {
      staleClose = barrier;
      addBarrier(barrier);
    };
    await service.openThread(
      runtimeMethodSchemas["thread.open"].params.parse({ threadId: session.id }),
    );
    const ended = new Promise<void>((resolve) =>
      service.onEvent((event) => {
        if (event.event.type === "turn.completed") resolve();
      }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: randomUUID(),
        threadId: session.id,
        turnId: randomUUID(),
        input: { text: "fixture" },
      }),
    );
    await ended;
    await service.detachThread(
      runtimeMethodSchemas["thread.detach"].params.parse({
        requestId: randomUUID(),
        threadId: session.id,
      }),
    );
    await service.openThread(
      runtimeMethodSchemas["thread.open"].params.parse({ threadId: session.id }),
    );
    assert.ok(staleEvent);
    assert.ok(staleClose);
    assert.throws(staleEvent, SessionOccupiedError);
    await assert.rejects(staleClose(), SessionOccupiedError);
    await assert.rejects(f.b.resumeSession(session.id), SessionOccupiedError);
  } finally {
    await service.close();
    await f.close();
  }
});
