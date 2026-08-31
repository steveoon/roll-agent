import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  McpClientManager,
  buildStdioChildEnv,
  shouldSuppressStdioChildStderrLine,
} from "./client-manager.ts";

const ORIGINAL_NODE_OPTIONS = process.env["NODE_OPTIONS"];
const ORIGINAL_ROLL_AGENT_LOG_LEVEL = process.env["ROLL_AGENT_LOG_LEVEL"];
const ORIGINAL_ROLL_TEST_INHERITED = process.env["ROLL_TEST_INHERITED"];

describe("buildStdioChildEnv", () => {
  afterEach(() => {
    restoreEnv("NODE_OPTIONS", ORIGINAL_NODE_OPTIONS);
    restoreEnv("ROLL_AGENT_LOG_LEVEL", ORIGINAL_ROLL_AGENT_LOG_LEVEL);
    restoreEnv("ROLL_TEST_INHERITED", ORIGINAL_ROLL_TEST_INHERITED);
  });

  it("sets quiet defaults and inherits parent env when agent env is absent", () => {
    process.env["ROLL_TEST_INHERITED"] = "secret";
    delete process.env["NODE_OPTIONS"];
    delete process.env["ROLL_AGENT_LOG_LEVEL"];

    const env = buildStdioChildEnv();

    assert.equal(env["NODE_OPTIONS"], "--disable-warning=ExperimentalWarning");
    assert.equal(env["ROLL_AGENT_LOG_LEVEL"], "warn");
    assert.equal(env["PYTHONUTF8"], "1");
    assert.equal(env["PYTHONIOENCODING"], "utf-8");
    assert.equal(env["ROLL_TEST_INHERITED"], "secret");
  });

  it("agent env overrides inherited parent env of the same name", () => {
    process.env["ROLL_TEST_INHERITED"] = "from-parent";

    const env = buildStdioChildEnv({ ROLL_TEST_INHERITED: "configured" });

    assert.equal(env["ROLL_TEST_INHERITED"], "configured");
  });

  it("respects explicit python encoding overrides", () => {
    const env = buildStdioChildEnv({
      PYTHONUTF8: "0",
      PYTHONIOENCODING: "gbk",
    });

    assert.equal(env["PYTHONUTF8"], "0");
    assert.equal(env["PYTHONIOENCODING"], "gbk");
  });

  it("preserves explicit agent env and appends experimental warning suppression", () => {
    process.env["ROLL_TEST_INHERITED"] = "from-parent";

    const env = buildStdioChildEnv({
      NODE_OPTIONS: "--max-old-space-size=4096",
      ROLL_AGENT_LOG_LEVEL: "debug",
      AGENT_TOKEN: "configured",
    });

    assert.equal(
      env["NODE_OPTIONS"],
      "--max-old-space-size=4096 --disable-warning=ExperimentalWarning",
    );
    assert.equal(env["ROLL_AGENT_LOG_LEVEL"], "debug");
    assert.equal(env["AGENT_TOKEN"], "configured");
    assert.equal(env["ROLL_TEST_INHERITED"], "from-parent");
  });

  it("does not duplicate existing warning suppression", () => {
    const env = buildStdioChildEnv({
      NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
    });

    assert.equal(env["NODE_OPTIONS"], "--disable-warning=ExperimentalWarning");
  });
});

describe("shouldSuppressStdioChildStderrLine", () => {
  it("suppresses Node experimental warnings and stdio startup info logs", () => {
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "(node:79713) ExperimentalWarning: Type Stripping is an experimental feature",
      ),
      true,
    );
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "(Use `node --trace-warnings ...` to show where the warning was created)",
      ),
      true,
    );
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "2026-06-18T07:08:38.099Z [INFO ] [reply-policy-tuner-agent] MCP Server running on stdio",
      ),
      true,
    );
  });

  it("keeps non-startup child stderr visible", () => {
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "2026-06-18T07:08:38.099Z [WARN ] [reply-policy-tuner-agent] missing optional config",
      ),
      false,
    );
    assert.equal(shouldSuppressStdioChildStderrLine("Error: failed to start"), false);
  });
});

describe("McpClientManager stdio stderr filtering", () => {
  it("suppresses startup noise while keeping real child stderr visible", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "roll-mcp-stderr-"));
    const scriptPath = join(tempDir, "fixture-agent.mjs");
    writeFileSync(scriptPath, buildFixtureAgentScript());

    const manager = new McpClientManager();
    const stderrLines: string[] = [];
    const originalWrite: typeof process.stderr.write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
      stderrLines.push(chunk.toString());
      const callback = args.find((arg): arg is (error?: Error | null) => void => {
        return typeof arg === "function";
      });
      callback?.();
      return true;
    }) as typeof process.stderr.write;

    try {
      const client = await manager.connect(
        "fixture-agent",
        { type: "stdio", command: process.execPath, args: [scriptPath] },
        process.cwd(),
      );

      const listed = await client.listTools();

      assert.deepEqual(listed.tools, []);
      const stderr = stderrLines.join("");
      assert.doesNotMatch(stderr, /ExperimentalWarning/);
      assert.doesNotMatch(stderr, /MCP Server running on stdio/);
      assert.match(stderr, /REAL_CHILD_ERROR visible/);
    } finally {
      process.stderr.write = originalWrite;
      await manager.disconnectAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("McpClientManager connection ownership and cancellation", () => {
  it("uses the SDK request timeout and does not cache a timed-out connection", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "roll-mcp-timeout-"));
    const scriptPath = join(tempDir, "unresponsive-agent.mjs");
    writeFileSync(scriptPath, buildUnresponsiveFixtureAgentScript());
    const manager = new McpClientManager();

    try {
      await assert.rejects(
        manager.connect(
          "timeout-agent",
          { type: "stdio", command: process.execPath, args: [scriptPath] },
          process.cwd(),
          { timeoutMs: 20 },
        ),
        (error: unknown) => error instanceof McpError && error.code === ErrorCode.RequestTimeout,
      );
      assert.equal(manager.isConnected("timeout-agent"), false);
    } finally {
      await manager.disconnectAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("cancels a real SDK stdio initialize request and cleans up the child transport", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "roll-mcp-abort-"));
    const scriptPath = join(tempDir, "unresponsive-agent.mjs");
    writeFileSync(scriptPath, buildUnresponsiveFixtureAgentScript());
    const manager = new McpClientManager();
    const controller = new AbortController();
    const abortReason = new Error("cancel real initialize");
    const abortHandle = setTimeout(() => controller.abort(abortReason), 20);

    try {
      await assert.rejects(
        manager.connect(
          "real-abort-agent",
          { type: "stdio", command: process.execPath, args: [scriptPath] },
          process.cwd(),
          { timeoutMs: 10_000, signal: controller.signal },
        ),
        (error: unknown) =>
          error !== abortReason &&
          error instanceof McpError &&
          error.code === ErrorCode.RequestTimeout,
      );
      assert.equal(manager.isConnected("real-abort-agent"), false);
    } finally {
      clearTimeout(abortHandle);
      await manager.disconnectAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("passes signal and timeout to the SDK connect request and cleans up after abort", async () => {
    const manager = new McpClientManager();
    const connectEntered = Promise.withResolvers<void>();
    const nativeConnect = Promise.withResolvers<void>();
    const controller = new AbortController();
    const abortReason = new Error("bootstrap cancelled");
    let requestOptions: RequestOptions | undefined;
    let closeCalls = 0;
    const client = installClientDouble(manager, {
      connect: async (_transport: Transport, options?: RequestOptions) => {
        requestOptions = options;
        options?.signal?.addEventListener(
          "abort",
          () => {
            nativeConnect.reject(options.signal?.reason);
          },
          { once: true },
        );
        connectEntered.resolve();
        await nativeConnect.promise;
      },
      close: async () => {
        closeCalls += 1;
      },
    });

    const connecting = manager.connectWithOwnership(
      "abort-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
      { timeoutMs: 1_234, signal: controller.signal },
    );
    const rejected = assert.rejects(connecting, (error: unknown) => error === abortReason);
    await connectEntered.promise;

    assert.equal(requestOptions?.timeout, 1_234);
    assert.equal(requestOptions?.signal?.aborted, false);
    controller.abort(abortReason);
    await rejected;

    nativeConnect.resolve();
    await Promise.resolve();
    assert.equal(closeCalls, 1);
    assert.equal(manager.isConnected("abort-agent"), false);
    await manager.disconnect("abort-agent", client);
    assert.equal(closeCalls, 1);
  });

  it("rejects a pre-aborted cached lookup without disconnecting the shared client", async () => {
    const manager = new McpClientManager();
    let connectCalls = 0;
    let closeCalls = 0;
    const client = installClientDouble(manager, {
      connect: async () => {
        connectCalls += 1;
      },
      close: async () => {
        closeCalls += 1;
      },
    });

    const first = await manager.connectWithOwnership(
      "cached-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
    );
    assert.equal(first.client, client);
    first.commit();

    const controller = new AbortController();
    const abortReason = new Error("already cancelled");
    controller.abort(abortReason);
    await assert.rejects(
      manager.connectWithOwnership("cached-agent", TEST_STDIO_TRANSPORT, process.cwd(), {
        signal: controller.signal,
      }),
      (error: unknown) => error === abortReason,
    );

    const shared = await manager.connectWithOwnership(
      "cached-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
    );
    assert.equal(shared.client, client);
    await shared.rollback();
    assert.equal(connectCalls, 1);
    assert.equal(closeCalls, 0);
    assert.equal(manager.isConnected("cached-agent"), true);
  });

  it("deduplicates concurrent connects and a creator rollback cannot close a follower", async () => {
    const manager = new McpClientManager();
    const connectEntered = Promise.withResolvers<void>();
    const releaseConnect = Promise.withResolvers<void>();
    const cancelledController = new AbortController();
    const cancelledReason = new Error("follower cancelled");
    let connectCalls = 0;
    let nativeSignal: AbortSignal | undefined;
    const client = installClientDouble(manager, {
      connect: async (_transport: Transport, options?: RequestOptions) => {
        connectCalls += 1;
        nativeSignal = options?.signal;
        connectEntered.resolve();
        await releaseConnect.promise;
      },
      close: async () => {},
    });

    const owner = manager.connectWithOwnership(
      "concurrent-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
    );
    await connectEntered.promise;
    const follower = manager.connectWithOwnership(
      "concurrent-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
    );
    const cancelledFollower = manager.connectWithOwnership(
      "concurrent-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
      { signal: cancelledController.signal },
    );
    const cancelled = assert.rejects(
      cancelledFollower,
      (error: unknown) => error === cancelledReason,
    );

    cancelledController.abort(cancelledReason);
    await cancelled;
    assert.equal(nativeSignal?.aborted, false);
    releaseConnect.resolve();

    const ownerAcquisition = await owner;
    const followerAcquisition = await follower;
    assert.equal(ownerAcquisition.client, client);
    assert.equal(followerAcquisition.client, client);
    followerAcquisition.commit();
    await ownerAcquisition.rollback();
    assert.equal(connectCalls, 1);
    assert.equal(manager.isConnected("concurrent-agent"), true);
  });

  it("closes an uncommitted shared generation only after its final acquisition rolls back", async () => {
    const manager = new McpClientManager();
    const connectEntered = Promise.withResolvers<void>();
    const releaseConnect = Promise.withResolvers<void>();
    let closeCalls = 0;
    installClientDouble(manager, {
      connect: async () => {
        connectEntered.resolve();
        await releaseConnect.promise;
      },
      close: async () => {
        closeCalls += 1;
      },
    });

    const owner = manager.connectWithOwnership(
      "rollback-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
    );
    await connectEntered.promise;
    const follower = manager.connectWithOwnership(
      "rollback-agent",
      TEST_STDIO_TRANSPORT,
      process.cwd(),
    );
    releaseConnect.resolve();
    const ownerAcquisition = await owner;
    const followerAcquisition = await follower;

    await ownerAcquisition.rollback();
    assert.equal(closeCalls, 0);
    assert.equal(manager.isConnected("rollback-agent"), true);

    await followerAcquisition.rollback();
    assert.equal(closeCalls, 1);
    assert.equal(manager.isConnected("rollback-agent"), false);
  });

  it("disconnectAll cancels and cleans a pending connection", async () => {
    const manager = new McpClientManager();
    const connectEntered = Promise.withResolvers<void>();
    const nativeConnect = Promise.withResolvers<void>();
    let closeCalls = 0;
    installClientDouble(manager, {
      connect: async (_transport: Transport, options?: RequestOptions) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            nativeConnect.reject(options.signal?.reason);
          },
          { once: true },
        );
        connectEntered.resolve();
        await nativeConnect.promise;
      },
      close: async () => {
        closeCalls += 1;
      },
    });

    const connecting = manager.connect("pending-agent", TEST_STDIO_TRANSPORT, process.cwd());
    const rejected = assert.rejects(connecting, /cancelled during disconnect/u);
    await connectEntered.promise;
    await manager.disconnectAll();
    await rejected;

    nativeConnect.resolve();
    await Promise.resolve();
    assert.equal(closeCalls, 1);
    assert.equal(manager.isConnected("pending-agent"), false);
  });

  it("conditional disconnect does not evict a replacement connection", async () => {
    const manager = new McpClientManager();
    const closeEntered = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const oldClient = installClientDouble(manager, {
      connect: async () => {},
      close: async () => {
        closeEntered.resolve();
        await releaseClose.promise;
      },
    });
    await manager.connect("replace-agent", TEST_STDIO_TRANSPORT, process.cwd());

    const disconnecting = manager.disconnect("replace-agent", oldClient);
    await closeEntered.promise;
    const replacementClient = {
      close: async () => {},
    } as Client;
    connectionMap(manager).set("replace-agent", {
      client: replacementClient,
      transportType: "stdio",
      generation: connectionGeneration(),
    });
    releaseClose.resolve();
    await disconnecting;

    assert.equal(connectionMap(manager).get("replace-agent")?.client, replacementClient);
    assert.equal(manager.isConnected("replace-agent"), true);
  });
});

describe("McpClientManager HTTP disconnect", () => {
  it("terminates an assigned HTTP session when SDK initialize validation fails", async () => {
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    let deleteUsedAbortedSignal = false;
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      const message =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as {
              readonly id?: number;
              readonly method?: string;
            });
      if (method === "POST" && message?.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2099-01-01",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-invalid-init",
            },
          },
        );
      }
      if (method === "DELETE") {
        deleteCalls += 1;
        deleteUsedAbortedSignal = init?.signal?.aborted === true;
        if (deleteUsedAbortedSignal) {
          throw init?.signal?.reason ?? new Error("DELETE signal already aborted");
        }
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected HTTP fixture request: ${method}`);
    }) as typeof fetch;

    const manager = new McpClientManager({ httpSessionTerminationTimeoutMs: 50 });
    try {
      await assert.rejects(
        manager.connect(
          "invalid-http-agent",
          { type: "streamable-http", endpoint: "https://fixture.invalid/mcp" },
          process.cwd(),
        ),
        /protocol version is not supported/u,
      );
      assert.equal(deleteCalls, 1);
      assert.equal(deleteUsedAbortedSignal, false);
      assert.equal(manager.isConnected("invalid-http-agent"), false);
    } finally {
      globalThis.fetch = originalFetch;
      await manager.disconnectAll();
    }
  });

  it("bounds a stalled independent HTTP termination after initialize validation fails", async () => {
    const originalFetch = globalThis.fetch;
    let deleteSignalPresent = false;
    let deleteSignalAborted = false;
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      const message =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as {
              readonly id?: number;
              readonly method?: string;
            });
      if (method === "POST" && message?.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2099-01-01",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-stalled-invalid-init",
            },
          },
        );
      }
      if (method === "DELETE") {
        const signal = init?.signal;
        deleteSignalPresent = signal !== undefined && signal !== null;
        return await new Promise<Response>((_resolve, reject) => {
          const safetyTimeout = setTimeout(
            () => reject(new Error("DELETE fixture safety timeout")),
            250,
          );
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(safetyTimeout);
              deleteSignalAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected HTTP fixture request: ${method}`);
    }) as typeof fetch;

    const manager = new McpClientManager({ httpSessionTerminationTimeoutMs: 20 });
    try {
      await assert.rejects(
        manager.connect(
          "stalled-invalid-http-agent",
          { type: "streamable-http", endpoint: "https://fixture.invalid/mcp" },
          process.cwd(),
        ),
        /MCP cleanup also failed/u,
      );
      assert.equal(deleteSignalPresent, true);
      assert.equal(deleteSignalAborted, true);
      assert.equal(manager.isConnected("stalled-invalid-http-agent"), false);
    } finally {
      globalThis.fetch = originalFetch;
      await manager.disconnectAll();
    }
  });

  it("preserves the negotiated protocol header when cancellation follows initialization", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const abortReason = new Error("cancel after initialize");
    let deleteCalls = 0;
    let negotiatedProtocolVersion: string | undefined;
    let deleteSessionId: string | null = null;
    let deleteProtocolVersion: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      const message =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as {
              readonly id?: number;
              readonly method?: string;
              readonly params?: { readonly protocolVersion?: string };
            });
      if (method === "POST" && message?.method === "initialize") {
        negotiatedProtocolVersion = message.params?.protocolVersion;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: negotiatedProtocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-post-initialize-abort",
            },
          },
        );
      }
      if (method === "POST" && message?.method === "notifications/initialized") {
        controller.abort(abortReason);
        return new Response(null, { status: 202 });
      }
      if (method === "DELETE") {
        const headers = new Headers(init?.headers);
        deleteCalls += 1;
        deleteSessionId = headers.get("mcp-session-id");
        deleteProtocolVersion = headers.get("mcp-protocol-version");
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected HTTP fixture request: ${method}`);
    }) as typeof fetch;

    const manager = new McpClientManager();
    try {
      await assert.rejects(
        manager.connect(
          "post-initialize-abort-agent",
          { type: "streamable-http", endpoint: "https://fixture.invalid/mcp" },
          process.cwd(),
          { signal: controller.signal },
        ),
        (error: unknown) => error === abortReason,
      );
      assert.equal(deleteCalls, 1);
      assert.equal(deleteSessionId, "session-post-initialize-abort");
      assert.equal(deleteProtocolVersion, negotiatedProtocolVersion);
      assert.notEqual(deleteProtocolVersion, null);
      assert.equal(manager.isConnected("post-initialize-abort-agent"), false);
    } finally {
      globalThis.fetch = originalFetch;
      await manager.disconnectAll();
    }
  });

  it("terminates the remote MCP session before closing and evicting the client", async () => {
    const order: string[] = [];
    const manager = new McpClientManager();
    const internals = manager as unknown as {
      readonly connections: Map<
        string,
        {
          readonly client: { close(): Promise<void> };
          readonly transportType: "streamable-http";
          readonly httpTransport: {
            readonly sessionId: string;
            terminateSession(): Promise<void>;
            close(): Promise<void>;
          };
          readonly generation: ReturnType<typeof connectionGeneration>;
        }
      >;
    };
    internals.connections.set("http-agent", {
      client: {
        close: async () => {
          order.push("close");
        },
      },
      transportType: "streamable-http",
      httpTransport: {
        sessionId: "session-1",
        terminateSession: async () => {
          order.push("terminate");
        },
        close: async () => {
          order.push("transport-close");
        },
      },
      generation: connectionGeneration(),
    });

    await manager.disconnect("http-agent");

    assert.deepEqual(order, ["terminate", "close"]);
    assert.equal(manager.isConnected("http-agent"), false);
  });

  it("still closes and evicts the HTTP client while surfacing session termination failure", async () => {
    const order: string[] = [];
    const manager = new McpClientManager();
    const internals = manager as unknown as {
      readonly connections: Map<
        string,
        {
          readonly client: { close(): Promise<void> };
          readonly transportType: "streamable-http";
          readonly httpTransport: {
            readonly sessionId: string;
            terminateSession(): Promise<void>;
            close(): Promise<void>;
          };
          readonly generation: ReturnType<typeof connectionGeneration>;
        }
      >;
    };
    internals.connections.set("http-agent", {
      client: {
        close: async () => {
          order.push("close");
        },
      },
      transportType: "streamable-http",
      httpTransport: {
        sessionId: "session-2",
        terminateSession: async () => {
          order.push("terminate");
          throw new Error("DELETE failed");
        },
        close: async () => {
          order.push("transport-close");
        },
      },
      generation: connectionGeneration(),
    });

    await assert.rejects(manager.disconnect("http-agent"), /DELETE failed/u);

    assert.deepEqual(order, ["terminate", "close"]);
    assert.equal(manager.isConnected("http-agent"), false);
  });

  it("bounds a stalled HTTP DELETE, forces transport close, then closes the client", async () => {
    const order: string[] = [];
    const termination = Promise.withResolvers<void>();
    const manager = new McpClientManager({ httpSessionTerminationTimeoutMs: 20 });
    const internals = manager as unknown as {
      readonly connections: Map<
        string,
        {
          readonly client: { close(): Promise<void> };
          readonly transportType: "streamable-http";
          readonly httpTransport: {
            readonly sessionId: string;
            terminateSession(): Promise<void>;
            close(): Promise<void>;
          };
          readonly generation: ReturnType<typeof connectionGeneration>;
        }
      >;
    };
    internals.connections.set("stalled-http-agent", {
      client: {
        close: async () => {
          order.push("client-close");
        },
      },
      transportType: "streamable-http",
      httpTransport: {
        sessionId: "session-stalled",
        terminateSession: async () => {
          order.push("terminate");
          await termination.promise;
        },
        close: async () => {
          order.push("transport-close");
          termination.reject(new Error("DELETE aborted by close"));
        },
      },
      generation: connectionGeneration(),
    });

    await assert.rejects(
      manager.disconnect("stalled-http-agent"),
      /HTTP session cleanup.*timed out/u,
    );

    assert.deepEqual(order, ["terminate", "transport-close", "client-close"]);
    assert.equal(manager.isConnected("stalled-http-agent"), false);
  });
});

const TEST_STDIO_TRANSPORT = {
  type: "stdio",
  command: process.execPath,
  args: [],
} as const;

type ManagedConnectionDouble = {
  readonly client: Client;
  readonly transportType: "stdio" | "streamable-http";
  readonly httpTransport?: {
    readonly sessionId?: string;
    terminateSession(): Promise<void>;
    close(): Promise<void>;
  };
  readonly generation: ReturnType<typeof connectionGeneration>;
};

function connectionGeneration() {
  return {
    consumers: new Set<symbol>(),
    committed: true,
    cleanupRequested: false,
    closing: false,
  };
}

function installClientDouble(
  manager: McpClientManager,
  client: Pick<Client, "connect" | "close">,
): Client {
  const completeClient = client as Client;
  const internals = manager as unknown as {
    createClient(): Client;
  };
  internals.createClient = () => completeClient;
  return completeClient;
}

function connectionMap(manager: McpClientManager): Map<string, ManagedConnectionDouble> {
  return (
    manager as unknown as {
      readonly connections: Map<string, ManagedConnectionDouble>;
    }
  ).connections;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function buildFixtureAgentScript(): string {
  return `
process.stderr.write("(node:12345) ExperimentalWarning: Type Stripping is an experimental feature\\n");
process.stderr.write("(Use \`node --trace-warnings ...\` to show where the warning was created)\\n");
process.stderr.write("2026-06-18T07:08:38.099Z [INFO ] [fixture-agent] MCP Server running on stdio\\n");
process.stderr.write("REAL_CHILD_ERROR visible\\n");

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    handleMessage(JSON.parse(line));
  }
});

function handleMessage(message) {
  if (message.method === "initialize") {
    writeResult(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture-agent", version: "0.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    writeResult(message.id, { tools: [] });
  }
}

function writeResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;
}

function buildUnresponsiveFixtureAgentScript(): string {
  return `
process.stdin.resume();
`;
}

describe("McpClientManager stdio maxBufferSize", () => {
  it("passes the declared maxBufferSize to the SDK so a tool result above 10 MiB survives", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "roll-mcp-buffer-"));
    const scriptPath = join(tempDir, "large-output-agent.mjs");
    writeFileSync(scriptPath, buildLargeOutputFixtureAgentScript(11 * 1024 * 1024));
    const manager = new McpClientManager();

    try {
      const client = await manager.connect(
        "large-output-agent",
        {
          type: "stdio",
          command: process.execPath,
          args: [scriptPath],
          maxBufferSize: 16 * 1024 * 1024,
        },
        process.cwd(),
      );

      const result = await client.callTool({ name: "blob", arguments: {} });

      const content = result["content"] as Array<{ type: string; text: string }>;
      assert.equal(content[0]?.type, "text");
      assert.equal(content[0]?.text.length, 11 * 1024 * 1024);
    } finally {
      await manager.disconnectAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function buildLargeOutputFixtureAgentScript(payloadBytes: number): string {
  return `
process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    handleMessage(JSON.parse(line));
  }
});

function handleMessage(message) {
  if (message.method === "initialize") {
    writeResult(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "large-output-agent", version: "0.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    writeResult(message.id, {
      tools: [{ name: "blob", description: "large text", inputSchema: { type: "object" } }],
    });
    return;
  }
  if (message.method === "tools/call") {
    writeResult(message.id, { content: [{ type: "text", text: "x".repeat(${payloadBytes}) }] });
  }
}

function writeResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;
}
