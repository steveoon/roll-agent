import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { RELAY_ERROR_CODES_V11 } from "@roll-agent/relay-protocol";

import {
  RELAY_CLIENT_TRANSPORT_ERROR_CODES,
  RelayClientError,
  type RelayClient,
  type RelayThread,
  type RelayThreadId,
  type RelayTurnId,
} from "./index.ts";
import {
  createRelayClientForTesting,
  type RelayScheduler,
  type RelaySocketHandlers,
  type RelayTimerHandle,
  type RelayWebSocketLike,
} from "./testing.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000002" as RelayThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000003";
const STREAM_ID = "00000000-0000-4000-8000-000000000004";
const RUNTIME_INSTANCE_ID = "00000000-0000-4000-8000-000000000005";
const INTERACTION_ID = "00000000-0000-4000-8000-000000000006";
const APPROVAL_ID = "00000000-0000-4000-8000-000000000007";
const USER_INPUT_INTERACTION_ID = "00000000-0000-4000-8000-000000000008";
const NOW = "2026-08-06T08:00:00.000Z";

function assertBrowserCloseCode(code: number): void {
  if (code !== 1000 && (code < 3000 || code > 4999)) {
    throw new DOMException("invalid code", "InvalidAccessError");
  }
}

class FakeRelayWebSocket implements RelayWebSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  readonly closeCodes: number[] = [];
  #handlers: RelaySocketHandlers | undefined;
  #readyState = 0;

  constructor(url: string) {
    this.url = url;
  }

  get readyState(): number {
    return this.#readyState;
  }

  setHandlers(handlers: RelaySocketHandlers): void {
    this.#handlers = handlers;
  }

  send(data: string): void {
    assert.equal(this.#readyState, 1, "client only sends on an open WebSocket");
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    assertBrowserCloseCode(code);
    this.closeCodes.push(code);
    if (this.#readyState === 3) {
      return;
    }
    this.#readyState = 3;
    this.#handlers?.onClose({ code, reason, wasClean: code === 1000 });
  }

  serverOpen(): void {
    this.#readyState = 1;
    this.#handlers?.onOpen();
  }

  serverMessage(value: unknown): void {
    this.#handlers?.onMessage(JSON.stringify(value));
  }

  serverRawMessage(value: unknown): void {
    this.#handlers?.onMessage(value);
  }

  serverClose(code = 1006, reason = "connection lost"): void {
    this.#readyState = 3;
    this.#handlers?.onClose({ code, reason, wasClean: false });
  }
}

interface TestHarness {
  readonly client: RelayClient;
  readonly sockets: FakeRelayWebSocket[];
}

interface ManualTimer {
  readonly callback: () => void;
  readonly delayMs: number;
}

class ManualRelayScheduler implements RelayScheduler {
  readonly #timers = new Map<RelayTimerHandle, ManualTimer>();
  #now = Date.parse(NOW);

  now(): number {
    return this.#now;
  }

  setTimer(callback: () => void, delayMs: number): RelayTimerHandle {
    const handle = globalThis.setTimeout(() => undefined, 60_000);
    this.#timers.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimer(handle: RelayTimerHandle): void {
    globalThis.clearTimeout(handle);
    this.#timers.delete(handle);
  }

  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  hasTimer(delayMs: number): boolean {
    return [...this.#timers.values()].some((timer) => timer.delayMs === delayMs);
  }

  runDelay(delayMs: number): void {
    const timerEntry = [...this.#timers.entries()].find(([, timer]) => timer.delayMs === delayMs);
    assert.ok(timerEntry, `expected a pending ${delayMs}ms timer`);
    const [handle, timer] = timerEntry;
    globalThis.clearTimeout(handle);
    this.#timers.delete(handle);
    this.#now += delayMs;
    timer.callback();
  }
}

function createUuidFactory(): () => string {
  let next = 100;
  return () => {
    const suffix = String(next).padStart(12, "0");
    next += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

function createHarness(
  requestTimeoutMs = 5_000,
  scheduler?: RelayScheduler,
  reconnectDelayMs = 0,
): TestHarness {
  const sockets: FakeRelayWebSocket[] = [];
  let sessionNumber = 0;
  const client = createRelayClientForTesting(
    {
      requestTimeoutMs,
      getSession: async () => {
        sessionNumber += 1;
        return {
          connectUrl: `wss://relay.example.test/browser?ticket=${sessionNumber}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    {
      createWebSocket: (url) => {
        const socket = new FakeRelayWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      createUuid: createUuidFactory(),
      reconnectDelayMs: () => reconnectDelayMs,
      ...(scheduler === undefined ? {} : { scheduler }),
    },
  );
  return { client, sockets };
}

async function eventually(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(0);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function sessionReady(workspaceStatus: "online" | "offline" = "online") {
  return {
    type: "session.ready",
    controlVersion: "1.0",
    relayProtocolVersion: "1.1",
    sessionId: "00000000-0000-4000-8000-000000000010",
    workspaceId: WORKSPACE_ID,
    workspaceStatus,
  } as const;
}

async function connectHarness(harness: TestHarness): Promise<FakeRelayWebSocket> {
  const connecting = harness.client.connect();
  await eventually(() => harness.sockets.length > 0, "WebSocket creation");
  const socket = harness.sockets.at(-1);
  assert.ok(socket);
  socket.serverOpen();
  socket.serverMessage(sessionReady());
  await connecting;
  return socket;
}

function parseSent(socket: FakeRelayWebSocket): ReadonlyArray<Record<string, unknown>> {
  return socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

function lastRequest(socket: FakeRelayWebSocket, method?: string): Record<string, unknown> {
  const requests = parseSent(socket).filter(
    (frame) =>
      frame.type === "runtime.request" && (method === undefined || frame.method === method),
  );
  const request = requests.at(-1);
  assert.ok(
    request,
    `expected outbound runtime.request${method === undefined ? "" : ` ${method}`}`,
  );
  return request;
}

function respond(
  socket: FakeRelayWebSocket,
  request: Record<string, unknown>,
  result: unknown,
): void {
  socket.serverMessage({
    type: "runtime.response",
    requestId: request.requestId,
    workspaceId: WORKSPACE_ID,
    result,
  });
}

function createSnapshot(options?: { readonly pendingApproval?: boolean }) {
  return {
    thread: {
      id: THREAD_ID,
      title: "Relay test",
      createdAt: NOW,
      updatedAt: NOW,
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals:
      options?.pendingApproval === true
        ? [
            {
              id: APPROVAL_ID,
              turnId: TURN_ID,
              agentName: "browser-use",
              toolName: "click",
              preview: { explanation: "Click the button" },
            },
          ]
        : [],
    transcriptCompleteness: "complete",
  } as const;
}

async function openThread(
  harness: TestHarness,
  socket: FakeRelayWebSocket,
  snapshot = createSnapshot(),
): Promise<RelayThread> {
  const opening = harness.client.openThread(THREAD_ID);
  const request = lastRequest(socket, "thread.open");
  respond(socket, request, snapshot);
  return opening;
}

function runtimeEvent(relaySequence: number, event: unknown, turnId: string = TURN_ID) {
  return {
    type: "runtime.event",
    workspaceId: WORKSPACE_ID,
    relaySequence,
    event: {
      protocolVersion: "1.1",
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      sequence: relaySequence,
      timestamp: NOW,
      threadId: THREAD_ID,
      turnId,
      event,
    },
  };
}

function ackSequences(socket: FakeRelayWebSocket): readonly unknown[] {
  return parseSent(socket)
    .filter((frame) => frame.type === "runtime.ack")
    .map((frame) => frame.throughRelaySequence);
}

function workspaceStatus(status: "online" | "offline") {
  return { type: "workspace.status", workspaceId: WORKSPACE_ID, status } as const;
}

function turnIdOf(request: Record<string, unknown>): RelayTurnId {
  const turnId = (request.params as Record<string, unknown>).turnId;
  assert.equal(typeof turnId, "string", "turn mutations carry a client-minted turnId");
  assert.ok(typeof turnId === "string");
  return turnId as RelayTurnId;
}

function approvalInteractionRequest(relaySequence: number) {
  return {
    type: "interaction.request",
    workspaceId: WORKSPACE_ID,
    relaySequence,
    interactionId: INTERACTION_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    expiresAt: "2099-01-01T00:00:00.000Z",
    sensitivity: "normal",
    method: "approval.request",
    projection: {
      approvalId: APPROVAL_ID,
      agentName: "browser-use",
      toolName: "click",
      explanation: "Click the button",
    },
  } as const;
}

test("connect validates session.ready as the first frame and ACKs the empty cursor", async () => {
  const harness = createHarness();
  const states: string[] = [];
  harness.client.subscribeConnection((state) => states.push(state.status));

  const socket = await connectHarness(harness);

  assert.deepEqual(states, ["idle", "connecting", "connected"]);
  assert.deepEqual(harness.client.getConnectionState(), {
    status: "connected",
    workspaceStatus: "online",
  });
  assert.deepEqual(parseSent(socket)[0], {
    type: "runtime.ack",
    workspaceId: WORKSPACE_ID,
    throughRelaySequence: -1,
  });
  harness.client.close();
});

test("connect fails closed when the first frame is not session.ready", async () => {
  const harness = createHarness();
  const connecting = harness.client.connect();
  await eventually(() => harness.sockets.length === 1, "WebSocket creation");
  const socket = harness.sockets[0];
  assert.ok(socket);
  socket.serverOpen();
  socket.serverMessage({
    type: "workspace.status",
    workspaceId: WORKSPACE_ID,
    status: "online",
  });

  await assert.rejects(connecting, RelayClientError);
  assert.equal(harness.client.getConnectionState().status, "closed");
});

test("connect classifies malformed secure session URLs as non-retryable", async (context) => {
  for (const connectUrl of [
    "WSS://relay.example.test/browser?ticket=uppercase",
    "wss://relay.example.test/browser?ticket=whitespace ",
  ]) {
    await context.test(connectUrl, async () => {
      let sessionCalls = 0;
      let socketCalls = 0;
      const client = createRelayClientForTesting(
        {
          getSession: async () => {
            sessionCalls += 1;
            return { connectUrl, expiresAt: "2099-01-01T00:00:00.000Z" };
          },
        },
        {
          createWebSocket: (url) => {
            socketCalls += 1;
            return new FakeRelayWebSocket(url);
          },
          createUuid: createUuidFactory(),
        },
      );

      await assert.rejects(client.connect(), (error: unknown) => {
        assert.ok(error instanceof RelayClientError);
        assert.equal(error.details.kind, "transport");
        assert.equal(error.details.code, RELAY_CLIENT_TRANSPORT_ERROR_CODES.invalidSession);
        assert.equal(error.details.retryable, false);
        return true;
      });
      assert.equal(sessionCalls, 1);
      assert.equal(socketCalls, 0);
      assert.deepEqual(client.getConnectionState(), { status: "closed", reason: "transport" });
      client.close();
    });
  }
});

test("a malformed reconnect session stops instead of scheduling another retry", async () => {
  const scheduler = new ManualRelayScheduler();
  const sockets: FakeRelayWebSocket[] = [];
  let sessionCalls = 0;
  const client = createRelayClientForTesting(
    {
      getSession: async () => {
        sessionCalls += 1;
        return {
          connectUrl:
            sessionCalls === 1
              ? "wss://relay.example.test/browser?ticket=valid"
              : "WSS://relay.example.test/browser?ticket=invalid",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    {
      createWebSocket: (url) => {
        const socket = new FakeRelayWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      createUuid: createUuidFactory(),
      reconnectDelayMs: () => 25,
      scheduler,
    },
  );

  const connecting = client.connect();
  await eventually(() => sockets.length === 1, "initial WebSocket creation");
  const socket = sockets[0];
  assert.ok(socket);
  socket.serverOpen();
  socket.serverMessage(sessionReady());
  await connecting;

  socket.serverClose();
  assert.equal(client.getConnectionState().status, "reconnecting");
  scheduler.runDelay(25);
  await eventually(() => client.getConnectionState().status === "closed", "permanent close");

  assert.equal(sessionCalls, 2);
  assert.equal(sockets.length, 1);
  assert.equal(scheduler.pendingTimerCount, 0);
  assert.deepEqual(client.getConnectionState(), { status: "closed", reason: "session" });
  client.close();
});

test("connect timeout closes an open socket that never receives session.ready", async () => {
  const scheduler = new ManualRelayScheduler();
  const harness = createHarness(5_000, scheduler);
  const connecting = harness.client.connect({ timeoutMs: 125 });
  await eventually(() => harness.sockets.length === 1, "WebSocket creation");
  const socket = harness.sockets[0];
  assert.ok(socket);
  socket.serverOpen();

  scheduler.runDelay(125);

  await assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof RelayClientError);
    assert.equal(error.details.kind, "transport");
    assert.equal(error.details.code, RELAY_CLIENT_TRANSPORT_ERROR_CODES.requestTimeout);
    return true;
  });
  assert.equal(socket.readyState, 3);
  assert.deepEqual(harness.client.getConnectionState(), {
    status: "closed",
    reason: "transport",
  });
});

test("connect AbortSignal closes an open socket while waiting for session.ready", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const connecting = harness.client.connect({ signal: controller.signal });
  await eventually(() => harness.sockets.length === 1, "WebSocket creation");
  const socket = harness.sockets[0];
  assert.ok(socket);
  socket.serverOpen();

  controller.abort();

  await assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof RelayClientError);
    assert.equal(error.details.kind, "transport");
    assert.equal(error.details.code, RELAY_CLIENT_TRANSPORT_ERROR_CODES.aborted);
    return true;
  });
  assert.equal(socket.readyState, 3);
  assert.deepEqual(harness.client.getConnectionState(), {
    status: "closed",
    reason: "transport",
  });
});

test("a late getSession result cannot create a socket after connect times out", async () => {
  const scheduler = new ManualRelayScheduler();
  const sockets: FakeRelayWebSocket[] = [];
  let resolveSession:
    | ((session: { readonly connectUrl: string; readonly expiresAt: string }) => void)
    | undefined;
  const session = new Promise<{ readonly connectUrl: string; readonly expiresAt: string }>(
    (resolve) => {
      resolveSession = resolve;
    },
  );
  const client = createRelayClientForTesting(
    {
      getSession: async () => session,
    },
    {
      createWebSocket: (url) => {
        const socket = new FakeRelayWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      createUuid: createUuidFactory(),
      reconnectDelayMs: () => 0,
      scheduler,
    },
  );
  const connecting = client.connect({ timeoutMs: 125 });

  scheduler.runDelay(125);
  await assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof RelayClientError);
    assert.equal(error.details.kind, "transport");
    assert.equal(error.details.code, RELAY_CLIENT_TRANSPORT_ERROR_CODES.requestTimeout);
    return true;
  });

  assert.ok(resolveSession);
  resolveSession({
    connectUrl: "wss://relay.example.test/browser?ticket=late",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await delay(0);

  assert.equal(sockets.length, 0);
  assert.deepEqual(client.getConnectionState(), {
    status: "closed",
    reason: "transport",
  });
});

test("lists and creates Threads through validated request/result schemas", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const summary = createSnapshot().thread;

  const listing = harness.client.listThreads({ limit: 20 });
  const listRequest = lastRequest(socket, "thread.list");
  assert.deepEqual(listRequest.params, { limit: 20 });
  respond(socket, listRequest, { items: [summary], nextCursor: null });
  assert.deepEqual(await listing, { items: [summary], nextCursor: null });

  const creating = harness.client.createThread({ title: "Relay test" });
  const createRequest = lastRequest(socket, "thread.create");
  assert.equal((createRequest.params as Record<string, unknown>).title, "Relay test");
  respond(socket, createRequest, { thread: summary });
  await eventually(
    () =>
      parseSent(socket).some(
        (frame) => frame.type === "runtime.request" && frame.method === "thread.snapshot",
      ),
    "created Thread snapshot request",
  );
  const snapshotRequest = lastRequest(socket, "thread.snapshot");
  respond(socket, snapshotRequest, createSnapshot());
  const thread = await creating;
  assert.equal(thread.id, THREAD_ID);
  assert.equal(thread.getSnapshot().status, "ready");
  harness.client.close();
});

test("a successful thread.create resolves to an error view when initial hydration fails", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const summary = createSnapshot().thread;

  const creating = harness.client.createThread({ title: "Created once" });
  const createRequest = lastRequest(socket, "thread.create");
  respond(socket, createRequest, { thread: summary });
  await eventually(
    () =>
      parseSent(socket).some(
        (frame) => frame.type === "runtime.request" && frame.method === "thread.snapshot",
      ),
    "created Thread hydration request",
  );
  const snapshotRequest = lastRequest(socket, "thread.snapshot");
  socket.serverMessage({
    type: "runtime.response",
    requestId: snapshotRequest.requestId,
    workspaceId: WORKSPACE_ID,
    error: { code: "WORKSPACE_OFFLINE", message: "Workspace offline", retryable: true },
  });

  const thread = await creating;
  const view = thread.getSnapshot();
  assert.equal(view.status, "error");
  assert.equal(view.error.kind, "remote");
  assert.equal(view.error.code, "WORKSPACE_OFFLINE");
  harness.client.close();
});

test("listener exceptions are isolated from Relay connection and ACK state", async () => {
  const harness = createHarness();
  harness.client.subscribeConnection(() => {
    throw new Error("connection renderer failed");
  });
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);
  thread.subscribe(() => {
    throw new Error("thread renderer failed");
  });

  socket.serverMessage(runtimeEvent(0, { type: "message.started", streamId: STREAM_ID }));

  assert.equal(harness.client.getConnectionState().status, "connected");
  assert.equal(thread.getSnapshot().liveAssistantMessages[0]?.status, "streaming");
  const acks = parseSent(socket).filter((frame) => frame.type === "runtime.ack");
  assert.equal(acks.at(-1)?.throughRelaySequence, 0);
  harness.client.close();
});

test("reduces streaming Chat and Interaction lifecycle while ACKing contiguous sequence", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  socket.serverMessage(runtimeEvent(0, { type: "message.started", streamId: STREAM_ID }));
  socket.serverMessage(
    runtimeEvent(1, { type: "message.delta", streamId: STREAM_ID, delta: "hel" }),
  );
  socket.serverMessage(
    runtimeEvent(2, { type: "message.delta", streamId: STREAM_ID, delta: "lo" }),
  );
  assert.deepEqual(thread.getSnapshot().liveAssistantMessages, [
    { status: "streaming", streamId: STREAM_ID, text: "hello" },
  ]);

  socket.serverMessage({
    type: "interaction.request",
    workspaceId: WORKSPACE_ID,
    relaySequence: 3,
    interactionId: INTERACTION_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    expiresAt: "2099-01-01T00:00:00.000Z",
    sensitivity: "normal",
    method: "approval.request",
    projection: {
      approvalId: APPROVAL_ID,
      agentName: "browser-use",
      toolName: "click",
      explanation: "Click the button",
    },
  });
  assert.equal(thread.getSnapshot().interactions[0]?.status, "pending");

  const approval = thread.getSnapshot().interactions.at(-1);
  assert.equal(approval?.status, "pending");
  assert.ok(approval?.status === "pending");
  const responding = thread.respond(approval.request.interactionId, { decision: "approve" });
  assert.equal(thread.getSnapshot().interactions[0]?.status, "responding");
  const candidateRequest = lastRequest(socket, "interaction.candidate");
  respond(socket, candidateRequest, { accepted: true });
  await responding;

  socket.serverMessage({
    type: "interaction.resolved",
    workspaceId: WORKSPACE_ID,
    relaySequence: 4,
    interactionId: INTERACTION_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    method: "approval.request",
  });
  assert.equal(thread.getSnapshot().interactions[0]?.status, "resolved");

  socket.serverMessage({
    type: "interaction.request",
    workspaceId: WORKSPACE_ID,
    relaySequence: 5,
    interactionId: USER_INPUT_INTERACTION_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    expiresAt: "2099-01-01T00:00:00.000Z",
    sensitivity: "normal",
    method: "userInput.request",
    projection: {
      title: "Confirm account",
      controls: [{ type: "text", id: "account", label: "Account", required: true }],
    },
  });
  const userInput = thread.getSnapshot().interactions.at(-1);
  assert.equal(userInput?.status, "pending");
  assert.ok(userInput?.status === "pending");
  const submitting = thread.respond(userInput.request.interactionId, {
    status: "submitted",
    values: [{ id: "account", value: "Ada" }],
  });
  const userInputCandidate = lastRequest(socket, "interaction.candidate");
  respond(socket, userInputCandidate, { accepted: true });
  await submitting;
  socket.serverMessage({
    type: "interaction.cancelled",
    workspaceId: WORKSPACE_ID,
    relaySequence: 6,
    interactionId: USER_INPUT_INTERACTION_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    method: "userInput.request",
  });
  assert.equal(thread.getSnapshot().interactions.at(-1)?.status, "cancelled");

  const acks = parseSent(socket).filter((frame) => frame.type === "runtime.ack");
  assert.equal(acks.at(-1)?.throughRelaySequence, 6);
  harness.client.close();
});

test("a local sequence hole snapshots the missing prefix before applying the buffered frame", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);
  const ackCountBeforeGap = parseSent(socket).filter(
    (frame) => frame.type === "runtime.ack",
  ).length;

  socket.serverMessage(runtimeEvent(2, { type: "message.started", streamId: STREAM_ID }));
  const recovery = lastRequest(socket, "thread.snapshot");
  respond(socket, recovery, createSnapshot());
  await eventually(
    () =>
      parseSent(socket).some(
        (frame) => frame.type === "runtime.ack" && frame.throughRelaySequence === 2,
      ),
    "gap recovery ACK",
  );

  assert.deepEqual(thread.getSnapshot().liveAssistantMessages, [
    { status: "streaming", streamId: STREAM_ID, text: "" },
  ]);
  const acks = parseSent(socket).filter((frame) => frame.type === "runtime.ack");
  assert.deepEqual(
    acks.slice(ackCountBeforeGap).map((frame) => frame.throughRelaySequence),
    [1, 2],
  );
  harness.client.close();
});

test("a local sequence hole preserves a buffered respondable Interaction", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  socket.serverMessage(approvalInteractionRequest(2));
  const recovery = lastRequest(socket, "thread.snapshot");
  respond(socket, recovery, createSnapshot({ pendingApproval: true }));
  await eventually(
    () => thread.getSnapshot().interactions[0]?.status === "pending",
    "buffered Interaction application",
  );

  const interaction = thread.getSnapshot().interactions[0];
  assert.equal(interaction?.status, "pending");
  assert.ok(interaction?.status === "pending");
  assert.equal(interaction.request.interactionId, INTERACTION_ID);
  const responding = thread.respond(interaction.request.interactionId, { decision: "approve" });
  const candidate = lastRequest(socket, "interaction.candidate");
  assert.equal((candidate.params as Record<string, unknown>).interactionId, INTERACTION_ID);
  respond(socket, candidate, { accepted: true });
  await responding;

  const acks = parseSent(socket).filter((frame) => frame.type === "runtime.ack");
  assert.equal(acks.at(-1)?.throughRelaySequence, 2);
  harness.client.close();
});

test("an in-flight mutation reconnects with the same Relay and Runtime request IDs", async () => {
  const harness = createHarness();
  const firstSocket = await connectHarness(harness);
  const thread = await openThread(harness, firstSocket);

  const sending = thread.send("continue the task");
  const firstFrame = lastRequest(firstSocket, "turn.start");
  firstSocket.serverClose();
  assert.equal(harness.client.getConnectionState().status, "reconnecting");

  await eventually(() => harness.sockets.length === 2, "reconnect WebSocket");
  const secondSocket = harness.sockets[1];
  assert.ok(secondSocket);
  assert.match(secondSocket.url, /ticket=2$/u);
  secondSocket.serverOpen();
  secondSocket.serverMessage(sessionReady());
  const replayedFrame = lastRequest(secondSocket, "turn.start");
  assert.equal(replayedFrame.requestId, firstFrame.requestId);
  assert.deepEqual(replayedFrame.params, firstFrame.params);

  const params = replayedFrame.params as Record<string, unknown>;
  respond(secondSocket, replayedFrame, { accepted: true, turnId: params.turnId });
  const result = await sending;
  assert.equal(result.turnId, params.turnId);
  harness.client.close();
});

test("a sent mutation timeout surfaces OUTCOME_UNKNOWN", async () => {
  const harness = createHarness(10);
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  const sending = thread.send("may have executed");
  await assert.rejects(sending, (error: unknown) => {
    assert.ok(error instanceof RelayClientError);
    assert.equal(error.details.kind, "transport");
    assert.equal(error.details.code, RELAY_CLIENT_TRANSPORT_ERROR_CODES.outcomeUnknown);
    return true;
  });
  harness.client.close();
});

test("REMOTE_REQUEST_DENIED stays typed and does not expose the Host reason", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  const sending = thread.send("forbidden request");
  const request = lastRequest(socket, "turn.start");
  socket.serverMessage({
    type: "runtime.response",
    requestId: request.requestId,
    workspaceId: WORKSPACE_ID,
    error: {
      code: RELAY_ERROR_CODES_V11.remoteRequestDenied,
      message: "local policy path /Users/private denied this method",
      retryable: false,
    },
  });

  await assert.rejects(sending, (error: unknown) => {
    assert.ok(error instanceof RelayClientError);
    assert.equal(error.details.kind, "remote");
    assert.equal(error.details.code, "REMOTE_REQUEST_DENIED");
    assert.equal(error.message, "Remote request denied");
    assert.doesNotMatch(error.message, /Users\/private/u);
    return true;
  });
  harness.client.close();
});

test("snapshot-only recovery never invents a respondable interactionId", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket, createSnapshot({ pendingApproval: true }));

  assert.equal(thread.getSnapshot().snapshot?.pendingApprovals.length, 1);
  assert.deepEqual(thread.getSnapshot().interactions, []);
  harness.client.close();
});

test("offline Workspace rejects new requests without emitting runtime.request", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);
  socket.serverMessage({
    type: "workspace.status",
    workspaceId: WORKSPACE_ID,
    status: "offline",
  });
  const requestCount = parseSent(socket).filter((frame) => frame.type === "runtime.request").length;

  await assert.rejects(thread.send("do not queue"), (error: unknown) => {
    assert.ok(error instanceof RelayClientError);
    assert.equal(error.details.kind, "transport");
    assert.equal(error.details.code, RELAY_CLIENT_TRANSPORT_ERROR_CODES.workspaceOffline);
    return true;
  });
  assert.equal(
    parseSent(socket).filter((frame) => frame.type === "runtime.request").length,
    requestCount,
  );
  harness.client.close();
});

test("an already-aborted request is never emitted", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);
  const requestCount = parseSent(socket).filter((frame) => frame.type === "runtime.request").length;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    thread.send("cancelled locally", { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof RelayClientError);
      assert.equal(error.details.kind, "transport");
      assert.equal(error.details.code, RELAY_CLIENT_TRANSPORT_ERROR_CODES.aborted);
      return true;
    },
  );
  assert.equal(
    parseSent(socket).filter((frame) => frame.type === "runtime.request").length,
    requestCount,
  );
  harness.client.close();
});

test("non-text WebSocket frames fail closed", async () => {
  const harness = createHarness();
  const connecting = harness.client.connect();
  await eventually(() => harness.sockets.length === 1, "WebSocket creation");
  const socket = harness.sockets[0];
  assert.ok(socket);
  socket.serverOpen();
  socket.serverRawMessage(new Uint8Array([1, 2, 3]));
  await assert.rejects(connecting, RelayClientError);
});

test("connect() during backoff cancels the timer and opens exactly one session", async () => {
  const scheduler = new ManualRelayScheduler();
  const harness = createHarness(5_000, scheduler, 25);
  const socket = await connectHarness(harness);

  socket.serverClose();
  assert.equal(harness.client.getConnectionState().status, "reconnecting");
  assert.ok(scheduler.hasTimer(25), "backoff timer is pending");

  const reconnecting = harness.client.connect();
  assert.equal(scheduler.hasTimer(25), false, "connect() clears the pending backoff timer");
  await eventually(() => harness.sockets.length === 2, "reconnect WebSocket");
  const second = harness.sockets[1];
  assert.ok(second);
  second.serverOpen();
  second.serverMessage(sessionReady());
  await reconnecting;

  assert.equal(harness.sockets.length, 2, "no parallel Relay session was opened");
  assert.deepEqual(harness.client.getConnectionState(), {
    status: "connected",
    workspaceStatus: "online",
  });
  harness.client.close();
});

test("connect() joins an in-flight backoff attempt instead of burning a second ticket", async () => {
  const scheduler = new ManualRelayScheduler();
  const sockets: FakeRelayWebSocket[] = [];
  let sessionCalls = 0;
  const client = createRelayClientForTesting(
    {
      requestTimeoutMs: 5_000,
      getSession: async () => {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return {
            connectUrl: "wss://relay.example.test/browser?ticket=1",
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
        }
        return new Promise(() => undefined);
      },
    },
    {
      createWebSocket: (url) => {
        const socket = new FakeRelayWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      createUuid: createUuidFactory(),
      reconnectDelayMs: () => 25,
      scheduler,
    },
  );

  const connecting = client.connect();
  await eventually(() => sockets.length === 1, "initial WebSocket creation");
  const socket = sockets[0];
  assert.ok(socket);
  socket.serverOpen();
  socket.serverMessage(sessionReady());
  await connecting;

  socket.serverClose();
  scheduler.runDelay(25);
  await eventually(() => sessionCalls === 2, "backoff session attempt");

  const joined = client.connect();
  await delay(0);
  assert.equal(sessionCalls, 2, "connect() reused the in-flight backoff attempt");
  assert.equal(sockets.length, 1, "the hanging attempt never created a second WebSocket");

  client.close();
  await assert.rejects(joined, RelayClientError);
  await delay(0);
  assert.deepEqual(client.getConnectionState(), { status: "closed", reason: "client" });
});

test("a superseded socket can neither reconnect nor feed the sequence cursor", async () => {
  const harness = createHarness();
  const first = await connectHarness(harness);
  const thread = await openThread(harness, first);

  first.serverClose();
  await eventually(() => harness.sockets.length === 2, "reconnect WebSocket");
  const second = harness.sockets[1];
  assert.ok(second);
  second.serverOpen();
  second.serverMessage(sessionReady());
  await eventually(
    () => harness.client.getConnectionState().status === "connected",
    "reconnected session",
  );

  first.serverMessage(runtimeEvent(0, { type: "message.started", streamId: STREAM_ID }));
  first.serverClose();

  assert.deepEqual(harness.client.getConnectionState(), {
    status: "connected",
    workspaceStatus: "online",
  });
  assert.equal(harness.sockets.length, 2, "the orphaned close did not open a third session");
  assert.deepEqual(
    thread.getSnapshot().liveAssistantMessages,
    [],
    "an orphaned socket cannot feed the reducer",
  );
  assert.equal(
    ackSequences(second).includes(0),
    false,
    "an orphaned socket cannot advance the ACK cursor",
  );
  harness.client.close();
});

test("a retryable session.error reconnects with a legal Browser close code", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);

  socket.serverMessage({ type: "session.error", code: "RATE_LIMITED", retryable: true });

  assert.deepEqual(socket.closeCodes, [4012]);
  assert.equal(
    harness.client.getConnectionState().status,
    "reconnecting",
    "a retryable session error must not be escalated to a permanent close",
  );
  await eventually(() => harness.sockets.length === 2, "reconnect WebSocket");
  harness.client.close();
});

test("a non-retryable session.error closes with a legal Browser close code", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  socket.serverMessage({ type: "session.error", code: "WORKSPACE_NOT_FOUND", retryable: false });

  assert.deepEqual(socket.closeCodes, [4008]);
  assert.deepEqual(harness.client.getConnectionState(), { status: "closed", reason: "session" });
  const view = thread.getSnapshot();
  assert.equal(view.status, "error");
  assert.equal(view.error.kind, "session");
  harness.client.close();
});

test("an invalid frame after session.ready closes with a legal Browser close code", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);

  socket.serverMessage({ type: "runtime.event", workspaceId: WORKSPACE_ID });

  assert.deepEqual(socket.closeCodes, [4002]);
  assert.deepEqual(harness.client.getConnectionState(), { status: "closed", reason: "protocol" });
});

test("a failed snapshot recovery closes with a legal Browser close code", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  await openThread(harness, socket);

  socket.serverMessage(runtimeEvent(2, { type: "message.started", streamId: STREAM_ID }));
  const recovery = lastRequest(socket, "thread.snapshot");
  socket.serverMessage({
    type: "runtime.response",
    requestId: recovery.requestId,
    workspaceId: WORKSPACE_ID,
    error: { code: "COMPANION_ERROR", message: "snapshot failed", retryable: true },
  });

  await eventually(() => socket.closeCodes.length > 0, "recovery close");
  assert.deepEqual(socket.closeCodes, [4012]);
  await eventually(
    () => harness.client.getConnectionState().status === "reconnecting",
    "reconnect after failed recovery",
  );
  harness.client.close();
});

test("a reconnect attempt timeout keeps retrying with backoff", async () => {
  const scheduler = new ManualRelayScheduler();
  const sockets: FakeRelayWebSocket[] = [];
  let sessionCalls = 0;
  const client = createRelayClientForTesting(
    {
      requestTimeoutMs: 200,
      getSession: async () => {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return {
            connectUrl: "wss://relay.example.test/browser?ticket=1",
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
        }
        return new Promise(() => undefined);
      },
    },
    {
      createWebSocket: (url) => {
        const socket = new FakeRelayWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      createUuid: createUuidFactory(),
      reconnectDelayMs: () => 25,
      scheduler,
    },
  );

  const connecting = client.connect();
  await eventually(() => sockets.length === 1, "initial WebSocket creation");
  const socket = sockets[0];
  assert.ok(socket);
  socket.serverOpen();
  socket.serverMessage(sessionReady());
  await connecting;

  socket.serverClose();
  scheduler.runDelay(25);
  await eventually(() => sessionCalls === 2, "backoff session attempt");

  scheduler.runDelay(200);
  await eventually(() => {
    const pending = client.getConnectionState();
    return pending.status === "reconnecting" && pending.attempt === 2;
  }, "a transient reconnect timeout schedules another backoff attempt");

  assert.ok(scheduler.hasTimer(25), "a new backoff timer is pending");
  client.close();
});

test("a restarted Workspace stream is adopted instead of deduplicated away", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  socket.serverMessage(runtimeEvent(0, { type: "message.started", streamId: STREAM_ID }));
  socket.serverMessage(
    runtimeEvent(1, { type: "message.delta", streamId: STREAM_ID, delta: "before" }),
  );
  assert.deepEqual(ackSequences(socket).at(-1), 1);

  socket.serverMessage(workspaceStatus("offline"));
  socket.serverMessage(workspaceStatus("online"));

  const converge = lastRequest(socket, "thread.snapshot");
  assert.notEqual(converge.requestId, undefined, "offline -> online converges through a Snapshot");
  respond(socket, converge, createSnapshot());
  await delay(0);

  socket.serverMessage(
    runtimeEvent(0, { type: "message.completed", streamId: STREAM_ID, text: "after restart" }),
  );

  assert.deepEqual(thread.getSnapshot().liveAssistantMessages, [
    { status: "completed", streamId: STREAM_ID, text: "after restart" },
  ]);
  assert.equal(ackSequences(socket).at(-1), 0, "the rewound stream becomes the new ACK baseline");
  harness.client.close();
});

test("a Workspace blip with a continuous sequence never re-applies delivered frames", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  socket.serverMessage(runtimeEvent(0, { type: "message.started", streamId: STREAM_ID }));
  socket.serverMessage(
    runtimeEvent(1, { type: "message.delta", streamId: STREAM_ID, delta: "hello" }),
  );

  socket.serverMessage(workspaceStatus("offline"));
  socket.serverMessage(workspaceStatus("online"));

  socket.serverMessage(runtimeEvent(2, { type: "message.delta", streamId: STREAM_ID, delta: "!" }));

  assert.deepEqual(thread.getSnapshot().liveAssistantMessages, [
    { status: "streaming", streamId: STREAM_ID, text: "hello!" },
  ]);
  assert.equal(ackSequences(socket).at(-1), 2, "a continuous stream keeps its cursor");
  harness.client.close();
});

test("a settled turn is never reverted to running or cancelling by a late response", async () => {
  const harness = createHarness();
  const socket = await connectHarness(harness);
  const thread = await openThread(harness, socket);

  const sending = thread.send("finishes before the response lands");
  const startRequest = lastRequest(socket, "turn.start");
  const turnId = turnIdOf(startRequest);

  socket.serverMessage(runtimeEvent(0, { type: "turn.completed" }, turnId));
  assert.deepEqual(thread.getSnapshot().turn, { status: "completed", turnId });

  respond(socket, startRequest, { accepted: true, turnId });
  await sending;
  assert.deepEqual(
    thread.getSnapshot().turn,
    { status: "completed", turnId },
    "turn.start must not resurrect a settled turn",
  );

  const cancelling = thread.cancel(turnId);
  const cancelRequest = lastRequest(socket, "turn.cancel");
  respond(socket, cancelRequest, { cancelling: true });
  await cancelling;
  assert.deepEqual(
    thread.getSnapshot().turn,
    { status: "completed", turnId },
    "turn.cancel must not resurrect a settled turn",
  );
  harness.client.close();
});

test("close() during an in-flight connect keeps the client terminal reason", async () => {
  const harness = createHarness();
  const connecting = harness.client.connect();
  await eventually(() => harness.sockets.length === 1, "WebSocket creation");
  const socket = harness.sockets[0];
  assert.ok(socket);
  socket.serverOpen();

  harness.client.close();

  await assert.rejects(connecting, RelayClientError);
  await delay(0);
  assert.deepEqual(harness.client.getConnectionState(), { status: "closed", reason: "client" });
});
