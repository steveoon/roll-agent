import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import {
  McpClientManager,
  McpConnectionCleanupError,
  type McpScopedConnectionAcquisition,
} from "../mcp/client-manager.ts";
import { rollConfigSchema } from "../config/schema.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { CoreAgentHost, type CoreAgentHostOptions } from "./agent-host.ts";

function agent(name: string): RegisteredAgent {
  return {
    skill: { name, description: name, metadata: {} },
    transport: { type: "stdio", command: "node", args: ["fixture.mjs"] },
    runtime: { ownership: "on-demand" },
    installPath: "/tmp",
    registeredAt: "2026-10-26T00:00:00Z",
    status: "idle",
  };
}

function client(tools: readonly Tool[] = []): Client {
  const result = new Client({ name: "host-test", version: "1" });
  result.listTools = async () => ({ tools: [...tools] });
  return result;
}

function acquisition(
  value: Client,
  overrides: Partial<Omit<McpScopedConnectionAcquisition, "client">> = {},
): McpScopedConnectionAcquisition {
  return {
    client: value,
    commit: () => {},
    rollback: async () => {},
    release: async () => {},
    setSampling: () => {},
    ...overrides,
  };
}

function operation(model: LanguageModelV4 = new MockLanguageModelV4({})) {
  return { model, signal: new AbortController().signal };
}

function options(overrides: Partial<CoreAgentHostOptions> = {}): CoreAgentHostOptions {
  return {
    config: rollConfigSchema.parse({
      llm: { defaultProvider: "mock", defaultModel: "mock", providers: {} },
      ask: {},
      agents: { dataDir: "/tmp/roll-host-test-unused" },
    }),
    agents: [],
    skillLibrary: null,
    ensureAgentReady: async () => {},
    ...overrides,
  };
}

const catalog = [
  {
    shortName: "probe",
    packageName: "@roll-agent/probe-agent",
    skillName: "probe",
    description: "probe",
    requiredEnv: [],
  },
];

test("CoreAgentHost bounds bootstrap concurrency and retains registration order", async () => {
  const started: string[] = [];
  const gates = new Map(
    Array.from({ length: 5 }, (_, i) => [String(i), Promise.withResolvers<void>()]),
  );
  const fourStarted = Promise.withResolvers<void>();
  const fifthStarted = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  const host = new CoreAgentHost(
    options({
      agents: Array.from({ length: 5 }, (_, i) => agent(String(i))),
      clientManager: {
        connectScoped: async (name) => {
          started.push(name);
          active += 1;
          peak = Math.max(peak, active);
          if (started.length === 4) fourStarted.resolve();
          if (started.length === 5) fifthStarted.resolve();
          await gates.get(name)?.promise;
          active -= 1;
          return acquisition(client([{ name: `tool-${name}`, inputSchema: { type: "object" } }]));
        },
      },
    }),
  );
  const ready = host.prepare(operation());
  await fourStarted.promise;
  assert.equal(started.length, 4);
  gates.get("2")?.resolve();
  await fifthStarted.promise;
  for (const gate of gates.values()) gate.resolve();
  const snapshot = await ready;
  assert.equal(peak, 4);
  assert.deepEqual(
    snapshot.sources.map((source) => source.agentName),
    ["0", "1", "2", "3", "4"],
  );
  await host.dispose();
});

test("CoreAgentHost settles late acquisitions during dispose and rejects new work", async () => {
  const connected = Promise.withResolvers<void>();
  const finishConnect = Promise.withResolvers<void>();
  let commits = 0;
  let rollbacks = 0;
  let cleanupFinished = false;
  const host = new CoreAgentHost(
    options({
      agents: [agent("late")],
      clientManager: {
        connectScoped: async () => {
          connected.resolve();
          await finishConnect.promise;
          return acquisition(client(), {
            commit: () => {
              commits += 1;
            },
            rollback: async () => {
              rollbacks += 1;
            },
          });
        },
      },
    }),
  );
  const ready = host.prepare(operation());
  const rejected = assert.rejects(ready, /closing/u);
  await connected.promise;
  const closing = host.dispose();
  closing.then(() => {
    cleanupFinished = true;
  });
  await Promise.resolve();
  assert.equal(cleanupFinished, false);
  assert.throws(() => host.prepare(operation()), /closing/u);
  finishConnect.resolve();
  await rejected;
  await closing;
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.equal(host.dispose(), closing);
});

test("CoreAgentHost refresh failure rolls back only its acquisition and preserves existing source", async () => {
  const active = client([{ name: "first", inputSchema: { type: "object" } }]);
  let acquisitions = 0;
  let commits = 0;
  let rollbacks = 0;
  let releases = 0;
  const host = new CoreAgentHost(
    options({
      agents: [agent("stable")],
      clientManager: {
        connectScoped: async () => {
          acquisitions += 1;
          return acquisition(active, {
            commit: () => {
              commits += 1;
            },
            rollback: async () => {
              rollbacks += 1;
            },
            release: async () => {
              releases += 1;
            },
          });
        },
      },
    }),
  );
  const input = operation();
  const snapshot = await host.prepare(input);
  active.listTools = async () => {
    throw new Error("refresh failed");
  };
  await assert.rejects(host.refresh("stable", input), /refresh failed/u);
  assert.equal(snapshot.sources[0]?.client, active);
  assert.equal(acquisitions, 2);
  assert.equal(commits, 1);
  assert.equal(rollbacks, 1);
  assert.equal(releases, 0);
  await host.dispose();
  assert.equal(releases, 1);
});

test("CoreAgentHost dispose remains single-flight when an abort listener disposes reentrantly", async () => {
  const entered = Promise.withResolvers<void>();
  let reentered: Promise<void> | undefined;
  const host = new CoreAgentHost(
    options({
      agents: [agent("reentrant")],
      ensureAgentReady: async (_agent, _env, signal) => {
        assert.ok(signal);
        const aborted = Promise.withResolvers<void>();
        signal.addEventListener(
          "abort",
          () => {
            reentered = host.dispose();
            aborted.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await aborted.promise;
        signal.throwIfAborted();
      },
    }),
  );
  const preparing = host.prepare(operation());
  const rejected = assert.rejects(preparing, /closing/u);
  await entered.promise;
  const closing = host.dispose();
  assert.equal(reentered, closing);
  await Promise.all([closing, rejected]);
});

test("CoreAgentHost applies the latest Sampling state to a connection arriving after model switch", async () => {
  const entered = Promise.withResolvers<void>();
  const finishConnect = Promise.withResolvers<void>();
  const first = new MockLanguageModelV4({});
  const second = new MockLanguageModelV4({});
  const sampled: { model: LanguageModelV4; options: SharedV4ProviderOptions | undefined }[] = [];
  const providerOptions = { mock: { temperature: 0.2 } };
  const host = new CoreAgentHost(
    options({
      agents: [agent("sampling")],
      clientManager: {
        connectScoped: async () => {
          entered.resolve();
          await finishConnect.promise;
          return acquisition(client(), {
            setSampling: (model, options) => {
              sampled.push({ model, options });
            },
          });
        },
      },
    }),
  );
  const ready = host.prepare(operation(first));
  await entered.promise;
  host.updateSampling(second, providerOptions);
  assert.equal(sampled.length, 0);
  finishConnect.resolve();
  await ready;
  assert.deepEqual(sampled, [{ model: second, options: providerOptions }]);
  await host.dispose();
});

test("adopting a shared cached client applies this host's Sampling model without reconnecting", async () => {
  const shared = client();
  let current: LanguageModelV4 | undefined;
  let connectCalls = 0;
  const manager = {
    connectScoped: async () => {
      connectCalls += 1;
      return acquisition(shared, {
        setSampling: (model) => {
          current = model;
        },
      });
    },
  };
  const first = new CoreAgentHost(
    options({ agents: [agent("sampling-shared")], clientManager: manager }),
  );
  const second = new CoreAgentHost(
    options({ agents: [agent("sampling-shared")], clientManager: manager }),
  );
  const firstModel = new MockLanguageModelV4({});
  const secondModel = new MockLanguageModelV4({});
  try {
    await first.prepare(operation(firstModel));
    assert.equal(current, firstModel);
    await second.prepare(operation(secondModel));
    assert.equal(current, secondModel);
    second.updateSampling(secondModel, undefined);
    assert.equal(connectCalls, 2);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
});

test("CoreAgentHost keeps every cleanup error and repeats the same failed disposal", async () => {
  const failures = [new Error("first close"), new Error("second close")];
  const host = new CoreAgentHost(
    options({
      agents: [agent("0"), agent("1")],
      clientManager: {
        connectScoped: async (name) =>
          acquisition(client(), {
            release: async () => {
              throw failures[Number(name)];
            },
          }),
      },
    }),
  );
  await host.prepare(operation());
  const closing = host.dispose();
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    return true;
  });
  assert.equal(host.dispose(), closing);
  await assert.rejects(host.dispose(), AggregateError);
});

test("CoreAgentHost retains cleanup failures that precede an acquisition result", async () => {
  const failure = new McpConnectionCleanupError(
    [new Error("initialize failed"), new Error("transport close failed")],
    "connection initialization and cleanup failed",
  );
  const issues: string[] = [];
  const host = new CoreAgentHost(
    options({
      agents: [agent("failed-initialize")],
      clientManager: {
        connectScoped: async () => {
          throw failure;
        },
      },
      onAgentBootstrapIssue: (issue) => {
        issues.push(issue.message);
      },
    }),
  );
  const snapshot = await host.prepare(operation());
  assert.equal(snapshot.sources.length, 0);
  assert.deepEqual(issues, [failure.message]);
  await assert.rejects(host.dispose(), (error) => error === failure);
  await assert.rejects(host.dispose(), (error) => error === failure);
});

test("CoreAgentHost disposal preserves a real manager's failed cleanup after handshake cancellation", async () => {
  const manager = new McpClientManager();
  const entered = Promise.withResolvers<void>();
  const handshake = Promise.withResolvers<void>();
  const controller = new AbortController();
  const cancellation = new Error("cancel after handshake");
  const cleanupFailure = new Error("connection close failed");
  const connectedClient = new Client(
    { name: "cancel-ready", version: "1" },
    { capabilities: { sampling: {} } },
  );
  connectedClient.connect = () => {
    entered.resolve();
    return handshake.promise;
  };
  connectedClient.close = async () => {
    throw cleanupFailure;
  };
  Reflect.set(manager, "createClient", () => connectedClient);
  const host = new CoreAgentHost(
    options({ agents: [agent("cancel-ready")], clientManager: manager }),
  );
  const preparing = host.prepare({ ...operation(), signal: controller.signal });
  const rejected = assert.rejects(preparing, (error) => error === cancellation);
  await entered.promise;
  handshake.resolve();
  await Promise.resolve();
  assert.equal(manager.isConnected("cancel-ready"), true);
  controller.abort(cancellation);
  await rejected;
  await assert.rejects(host.dispose(), (error) => {
    assert.ok(error instanceof McpConnectionCleanupError);
    assert.deepEqual(error.errors, [cancellation, cleanupFailure]);
    return true;
  });
  assert.equal(manager.isConnected("cancel-ready"), false);
});

test("two CoreAgentHosts sharing a real MCP manager release only their own connection ownership", async () => {
  const script = `
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\\n")) {
        const end = buffer.indexOf("\\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        const results = {
          initialize: { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shared-fixture", version: "1" } },
          "tools/list": { tools: [{ name: "inspect", inputSchema: { type: "object" } }] },
          "tools/call": { content: [{ type: "text", text: "still connected" }] },
        };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] ?? {} }) + "\\n");
      }
    });
  `;
  const sharedAgent: RegisteredAgent = {
    ...agent("shared-real"),
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
    },
  };
  const manager = new McpClientManager();
  const first = new CoreAgentHost(options({ agents: [sharedAgent], clientManager: manager }));
  const second = new CoreAgentHost(options({ agents: [sharedAgent], clientManager: manager }));
  const sharedModel = new MockLanguageModelV4({});
  try {
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first.prepare(operation(sharedModel)),
      second.prepare(operation(sharedModel)),
    ]);
    assert.equal(firstSnapshot.sources[0]?.client, secondSnapshot.sources[0]?.client);
    await first.dispose();
    assert.equal(manager.isConnected("shared-real"), true);
    const source = secondSnapshot.sources[0];
    assert.ok(source);
    const result = await source.client.callTool({ name: "inspect", arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: "still connected" }]);
    await second.dispose();
    assert.equal(manager.isConnected("shared-real"), false);
  } finally {
    await Promise.allSettled([first.dispose(), second.dispose()]);
    await manager.disconnectAll();
  }
});

test("CoreAgentHost preserves a completed install fact when cancelled and waits before disposing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-host-install-"));
  const entered = Promise.withResolvers<void>();
  const finishInstall = Promise.withResolvers<void>();
  const signal = new AbortController();
  let installs = 0;
  const host = new CoreAgentHost({
    config: rollConfigSchema.parse({
      llm: { defaultProvider: "mock", defaultModel: "mock", providers: {} },
      ask: {},
      agents: { dataDir: dir },
    }),
    skillLibrary: null,
    resolveCatalogFn: async () => catalog,
    installAgentFn: async () => {
      installs += 1;
      entered.resolve();
      await finishInstall.promise;
      return { ok: true, agent: agent("probe"), envReport: undefined, started: false };
    },
  });
  try {
    await host.prepare(operation());
    const installing = host.install("probe", () => {}, signal.signal);
    await entered.promise;
    signal.abort(new Error("cancel installation wait"));
    const closing = host.dispose();
    let closed = false;
    closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    finishInstall.resolve();
    const result = await installing;
    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.ok && result.outcome.agentName, "probe");
    assert.equal(result.outcome.ok && result.outcome.refreshApplied, false);
    assert.equal(installs, 1);
    await closing;
  } finally {
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CoreAgentHost projects tool resource and observation metadata without losing schema semantics", async () => {
  const host = new CoreAgentHost(
    options({
      agents: [agent("metadata")],
      clientManager: {
        connectScoped: async () =>
          acquisition(
            client([
              {
                name: "write",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
                annotations: { destructiveHint: true },
                _meta: {
                  "roll/resourceHints": [{ field: "path", kind: "file", mode: "write" }],
                  "roll/executionTimeoutMs": 5_000,
                  "roll/observationRetention": { kind: "browser-ax-snapshot" },
                },
              },
            ]),
          ),
      },
    }),
  );
  const snapshot = await host.prepare(operation());
  const source = snapshot.sources[0];
  const tool = source?.tools[0];
  assert.equal(source?.resourceBaseDir, "/tmp");
  assert.deepEqual(tool?.resourceHints, [{ field: "path", kind: "file", mode: "write" }]);
  assert.deepEqual(tool?.annotations, { destructiveHint: true });
  assert.deepEqual(tool?.observationRetention, { kind: "browser-ax-snapshot" });
  assert.equal(tool?.tool.executionTimeoutMs, 5_000);
  assert.deepEqual(tool?.tool.inputSchema.required, ["path"]);
  await host.dispose();
});
