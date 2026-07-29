import assert from "node:assert/strict";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import {
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  runtimeEventEnvelopeSchema,
  type JsonRpcRequest,
  type RuntimeEventEnvelope,
} from "@roll-agent/protocol";
import {
  RollNodeClient,
  RollProtocolViolationError,
  RollRequestFrameTooLargeError,
  RollRequestTimeoutError,
  RollRpcError,
  RollRuntimeClosingError,
  RollRuntimeExitedError,
  RollRuntimeShutdownTimeoutError,
  RollUncorrelatedRpcError,
  type RuntimeClientExit,
  type RuntimeClientTransport,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000301",
  thread: "00000000-0000-4000-8000-000000000302",
  turn: "00000000-0000-4000-8000-000000000303",
  request: "00000000-0000-4000-8000-000000000304",
} as const;

class MemoryTransport implements RuntimeClientTransport {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  close(): void {
    this.exit(0, null);
  }

  terminate(): void {
    this.exit(null, "SIGTERM");
  }

  forceClose(): void {
    this.exit(null, "SIGKILL");
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }
}

class TerminatesAfterGracefulTimeoutTransport extends MemoryTransport {
  closeCalls = 0;
  terminateCalls = 0;
  forceCloseCalls = 0;

  override close(): void {
    this.closeCalls += 1;
  }

  override terminate(): void {
    this.terminateCalls += 1;
    this.exit(null, "SIGTERM");
  }

  override forceClose(): void {
    this.forceCloseCalls += 1;
    this.exit(null, "SIGKILL");
  }
}

function writeJson(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function installFakeRuntime(transport: MemoryTransport): void {
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    switch (request.method) {
      case RUNTIME_METHODS.initialize:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            runtimeInstanceId: IDS.runtime,
            server: {
              name: "fake-runtime",
              version: "1.0.0",
              runtimeVersion: "0.9.0",
            },
            features: ["thread-management", "turns"],
            limits: {
              maxFrameBytes: 4 * 1_024 * 1_024,
              maxPageSize: 500,
              eventReplay: false,
              idempotencyCacheEntries: 10_000,
            },
          },
        });
        return;
      case RUNTIME_METHODS.threadList:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: { items: [], nextCursor: null },
        });
        return;
      case RUNTIME_METHODS.threadOpen:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32_000,
            message: "missing",
            data: { rollCode: "THREAD_NOT_FOUND", retryable: false },
          },
        });
        return;
      case RUNTIME_METHODS.turnStart:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: { accepted: true, turnId: IDS.turn },
        });
        return;
      default:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_601, message: "Method not found" },
        });
    }
  });
}

function terminalEvent(): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: IDS.runtime,
    sequence: 1,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: { type: "turn.completed" },
  });
}

test("RollNodeClient initializes, validates responses and surfaces structured errors", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const stderr: string[] = [];
  const client = await RollNodeClient.connect({
    transport,
    onStderr: (line) => stderr.push(line),
  });

  assert.deepEqual(await client.request(RUNTIME_METHODS.threadList, {}), {
    items: [],
    nextCursor: null,
  });
  await assert.rejects(
    client.request(RUNTIME_METHODS.threadOpen, { threadId: IDS.thread }),
    (error: unknown) => {
      assert.ok(error instanceof RollRpcError);
      assert.equal(error.data?.rollCode, "THREAD_NOT_FOUND");
      return true;
    },
  );
  transport.stderr.write("runtime diagnostic\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(stderr, ["runtime diagnostic"]);
  client.close();
});

test("RollNodeClient marks only unterminated active Turns as outcome unknown", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const unknown: string[] = [];
  const events: RuntimeEventEnvelope[] = [];
  const client = await RollNodeClient.connect({
    transport,
    onTurnOutcomeUnknown: (turnId) => unknown.push(turnId),
  });
  client.onEvent((event) => events.push(event));

  await client.request(RUNTIME_METHODS.turnStart, {
    requestId: IDS.request,
    threadId: IDS.thread,
    turnId: IDS.turn,
    input: { text: "hello" },
  });
  transport.exit(1, null);
  assert.deepEqual(client.getOutcomeUnknownTurnIds(), [IDS.turn]);
  assert.deepEqual(unknown, [IDS.turn]);

  const completedTransport = new MemoryTransport();
  installFakeRuntime(completedTransport);
  const completedClient = await RollNodeClient.connect({ transport: completedTransport });
  await completedClient.request(RUNTIME_METHODS.turnStart, {
    requestId: IDS.request,
    threadId: IDS.thread,
    turnId: IDS.turn,
    input: { text: "hello" },
  });
  writeJson(completedTransport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_EVENT_NOTIFICATION,
    params: terminalEvent(),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  completedTransport.exit(1, null);
  assert.deepEqual(completedClient.getOutcomeUnknownTurnIds(), []);
  assert.deepEqual(events, []);
});

test("RollNodeClient.start requires an explicit cwd before spawning", async () => {
  await assert.rejects(RollNodeClient.start({ cwd: "   " }), /requires an explicit non-empty cwd/u);
});

test("RollNodeClient retries retryable reads but never retries turn.start", async () => {
  const transport = new MemoryTransport();
  let listCalls = 0;
  let turnCalls = 0;
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "retry-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: ["thread-management"],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: false,
            idempotencyCacheEntries: 10_000,
          },
        },
      });
      return;
    }
    if (request.method === RUNTIME_METHODS.threadList) {
      listCalls += 1;
      writeJson(
        transport.stdout,
        listCalls === 1
          ? {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32_000,
                message: "retry read",
                data: { rollCode: "RUNTIME_CLOSING", retryable: true },
              },
            }
          : {
              jsonrpc: "2.0",
              id: request.id,
              result: { items: [], nextCursor: null },
            },
      );
      return;
    }
    if (request.method === RUNTIME_METHODS.turnStart) {
      turnCalls += 1;
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32_000,
          message: "do not retry mutation",
          data: { rollCode: "RUNTIME_CLOSING", retryable: true },
        },
      });
    }
  });

  const client = await RollNodeClient.connect({
    transport,
    maxReadRetries: 1,
    readRetryDelayMs: 0,
  });
  assert.deepEqual(await client.request(RUNTIME_METHODS.threadList, {}), {
    items: [],
    nextCursor: null,
  });
  assert.equal(listCalls, 2);
  await assert.rejects(
    client.request(RUNTIME_METHODS.turnStart, {
      requestId: IDS.request,
      threadId: IDS.thread,
      turnId: IDS.turn,
      input: { text: "do not replay" },
    }),
    RollRpcError,
  );
  assert.equal(turnCalls, 1);
  client.close();
});

test("RollNodeClient exposes negotiated initialization and idle runtime exit", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });

  assert.equal(client.getInitializationResult().runtimeInstanceId, IDS.runtime);
  assert.equal(client.getInitializationResult().protocolVersion, RUNTIME_PROTOCOL_VERSION);

  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));
  transport.exit(17, null);
  const result = await exited;
  assert.equal(result.code, 17);
  assert.ok(result.error instanceof RollRuntimeExitedError);

  const lateExit = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));
  assert.equal((await lateExit).code, 17);
});

test("RollNodeClient shutdown waits for exit, stays idempotent and preserves final stderr", async () => {
  class DeferredShutdownTransport extends MemoryTransport {
    closeCalls = 0;
    terminateCalls = 0;
    forceCloseCalls = 0;

    override close(): void {
      this.closeCalls += 1;
    }

    override terminate(): void {
      this.terminateCalls += 1;
      this.exit(null, "SIGTERM");
    }

    override forceClose(): void {
      this.forceCloseCalls += 1;
      this.exit(null, "SIGKILL");
    }
  }

  const transport = new DeferredShutdownTransport();
  installFakeRuntime(transport);
  const stderr: string[] = [];
  const client = await RollNodeClient.connect({
    transport,
    onStderr: (line) => stderr.push(line),
  });

  const firstShutdown = client.shutdown({
    gracefulTimeoutMs: 1_000,
    terminateTimeoutMs: 1_000,
    forceKillTimeoutMs: 1_000,
  });
  const secondShutdown = client.shutdown({
    gracefulTimeoutMs: 1,
    terminateTimeoutMs: 1,
    forceKillTimeoutMs: 1,
  });
  assert.equal(firstShutdown, secondShutdown);
  assert.equal(transport.closeCalls, 1);
  await assert.rejects(client.request(RUNTIME_METHODS.threadList, {}), RollRuntimeClosingError);

  transport.stderr.write("final cleanup diagnostic\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  transport.exit(0, null);
  const result = await firstShutdown;

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(transport.terminateCalls, 0);
  assert.equal(transport.forceCloseCalls, 0);
  assert.deepEqual(stderr, ["final cleanup diagnostic"]);
});

test("RollNodeClient shutdown terminates a Runtime that misses the graceful deadline", async () => {
  class StubbornTransport extends MemoryTransport {
    closeCalls = 0;
    terminateCalls = 0;
    forceCloseCalls = 0;

    override close(): void {
      this.closeCalls += 1;
    }

    override terminate(): void {
      this.terminateCalls += 1;
      this.exit(null, "SIGTERM");
    }

    override forceClose(): void {
      this.forceCloseCalls += 1;
      this.exit(null, "SIGKILL");
    }
  }

  const transport = new StubbornTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const result = await client.shutdown({
    gracefulTimeoutMs: 10,
    terminateTimeoutMs: 1_000,
    forceKillTimeoutMs: 1_000,
  });

  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.terminateCalls, 1);
  assert.equal(transport.forceCloseCalls, 0);
  assert.equal(result.signal, "SIGTERM");
});

test("RollNodeClient shutdown force-closes a Runtime that ignores termination", async () => {
  class HardStopTransport extends MemoryTransport {
    override close(): void {}

    override terminate(): void {}

    override forceClose(): void {
      this.exit(null, "SIGKILL");
    }
  }

  const transport = new HardStopTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const result = await client.shutdown({
    gracefulTimeoutMs: 10,
    terminateTimeoutMs: 10,
    forceKillTimeoutMs: 1_000,
  });

  assert.equal(result.signal, "SIGKILL");
});

test("RollNodeClient shutdown reports a bounded failure when forced close cannot finish", async () => {
  class UnresponsiveTransport extends MemoryTransport {
    override close(): void {}

    override terminate(): void {}

    override forceClose(): void {}
  }

  const transport = new UnresponsiveTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });

  await assert.rejects(
    client.shutdown({
      gracefulTimeoutMs: 10,
      terminateTimeoutMs: 10,
      forceKillTimeoutMs: 10,
    }),
    RollRuntimeShutdownTimeoutError,
  );
});

test("RollNodeClient closes transport when initialization times out", async () => {
  class TrackingTransport extends MemoryTransport {
    closed = false;

    override close(): void {
      this.closed = true;
      super.close();
    }
  }

  const transport = new TrackingTransport();
  await assert.rejects(
    RollNodeClient.connect({ transport, requestTimeoutMs: 20 }),
    RollRequestTimeoutError,
  );
  assert.equal(transport.closed, true);
});

test("RollNodeClient rejects malformed frames as protocol violations", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

  transport.stdout.write("{not-json}\n");
  const result = await exited;
  assert.ok(result.error instanceof RollProtocolViolationError);
  await assert.rejects(client.request(RUNTIME_METHODS.threadList, {}), RollProtocolViolationError);
});

test("RollNodeClient protocol failures still escalate until the Runtime process exits", async () => {
  const transport = new TerminatesAfterGracefulTimeoutTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({
    transport,
    shutdownOptions: {
      gracefulTimeoutMs: 10,
      terminateTimeoutMs: 1_000,
      forceKillTimeoutMs: 1_000,
    },
  });
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

  transport.stdout.write("{not-json}\n");
  const result = await exited;

  assert.ok(result.error instanceof RollProtocolViolationError);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.terminateCalls, 1);
  assert.equal(transport.forceCloseCalls, 0);
  assert.equal((await client.shutdown()).error, result.error);
});

test(
  "RollNodeClient terminates a real child process after a protocol failure",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = [
      'import { createInterface } from "node:readline";',
      "const reader = createInterface({ input: process.stdin });",
      'reader.once("line", (line) => {',
      "  const request = JSON.parse(line);",
      "  process.stdout.write(`${JSON.stringify({",
      '    jsonrpc: "2.0",',
      "    id: request.id,",
      "    result: {",
      `      protocolVersion: "${RUNTIME_PROTOCOL_VERSION}",`,
      `      runtimeInstanceId: "${IDS.runtime}",`,
      '      server: { name: "child-fixture", version: "1.0.0", runtimeVersion: "0.9.0" },',
      '      features: ["thread-management"],',
      "      limits: {",
      "        maxFrameBytes: 4194304,",
      "        maxPageSize: 500,",
      "        eventReplay: false,",
      "        idempotencyCacheEntries: 10000,",
      "      },",
      "    },",
      "  })}\\n`);",
      '  setTimeout(() => process.stdout.write("{not-json}\\n"), 25);',
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const client = await RollNodeClient.start({
      cwd: process.cwd(),
      command: process.execPath,
      args: ["--input-type=module", "--eval", fixture],
      requestTimeoutMs: 1_000,
      shutdownOptions: {
        gracefulTimeoutMs: 10,
        terminateTimeoutMs: 1_000,
        forceKillTimeoutMs: 1_000,
      },
    });
    const result = await new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

    assert.ok(result.error instanceof RollProtocolViolationError);
    assert.equal(result.signal, "SIGTERM");
    assert.equal((await client.shutdown()).error, result.error);
  },
);

test("RollNodeClient treats id:null errors as structured uncorrelated RPC failures", async () => {
  const transport = new TerminatesAfterGracefulTimeoutTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({
    transport,
    shutdownOptions: {
      gracefulTimeoutMs: 10,
      terminateTimeoutMs: 1_000,
      forceKillTimeoutMs: 1_000,
    },
  });
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32_700, message: "Parse error" },
  });
  const result = await exited;

  assert.ok(result.error instanceof RollUncorrelatedRpcError);
  assert.ok(result.error instanceof RollRpcError);
  assert.equal(result.error.code, -32_700);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.terminateCalls, 1);
  assert.equal(transport.forceCloseCalls, 0);
});

test("RollNodeClient rejects outbound frames above the negotiated limit before writing", async () => {
  const transport = new MemoryTransport();
  const methods: string[] = [];
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    methods.push(request.method);
    if (request.method !== RUNTIME_METHODS.initialize) {
      return;
    }
    writeJson(transport.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: IDS.runtime,
        server: {
          name: "small-frame-runtime",
          version: "1.0.0",
          runtimeVersion: "0.9.0",
        },
        features: ["thread-management", "turns"],
        limits: {
          maxFrameBytes: 1_024,
          maxPageSize: 500,
          eventReplay: false,
          idempotencyCacheEntries: 10_000,
        },
      },
    });
  });
  const client = await RollNodeClient.connect({ transport, maxFrameBytes: 4_096 });

  await assert.rejects(
    client.request(RUNTIME_METHODS.turnStart, {
      requestId: IDS.request,
      threadId: IDS.thread,
      turnId: IDS.turn,
      input: { text: "x".repeat(2_000) },
    }),
    RollRequestFrameTooLargeError,
  );
  assert.deepEqual(methods, [RUNTIME_METHODS.initialize]);
  assert.deepEqual(client.getOutcomeUnknownTurnIds(), []);
  await client.shutdown();
});

test("RollNodeClient rejects invalid method results and stops the connection", async () => {
  const transport = new MemoryTransport();
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "invalid-result-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: ["thread-management"],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: false,
            idempotencyCacheEntries: 10_000,
          },
        },
      });
      return;
    }
    writeJson(transport.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: { items: "not-an-array", nextCursor: null },
    });
  });

  const client = await RollNodeClient.connect({ transport });
  await assert.rejects(client.request(RUNTIME_METHODS.threadList, {}), RollProtocolViolationError);
});

test("RollNodeClient does not retry thread.open because opening mutates runtime state", async () => {
  const transport = new MemoryTransport();
  let openCalls = 0;
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "open-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: ["thread-management"],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: false,
            idempotencyCacheEntries: 10_000,
          },
        },
      });
      return;
    }
    if (request.method === RUNTIME_METHODS.threadOpen) {
      openCalls += 1;
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32_000,
          message: "retryable but stateful",
          data: { rollCode: "RUNTIME_CLOSING", retryable: true },
        },
      });
    }
  });

  const client = await RollNodeClient.connect({
    transport,
    maxReadRetries: 3,
    readRetryDelayMs: 0,
  });
  await assert.rejects(
    client.request(RUNTIME_METHODS.threadOpen, { threadId: IDS.thread }),
    RollRpcError,
  );
  assert.equal(openCalls, 1);
  client.close();
});
