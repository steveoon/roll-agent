import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentContext } from "./context.ts";
import { executeToolForMcp, registerTool, resolveAgentLogLevel } from "./define-agent.ts";
import { defineTool } from "./define-tool.ts";
import { StructuredToolError } from "./tool-error.ts";

const TEST_CONTEXT = {
  llm: {
    generateText: async () => "",
  },
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
} satisfies AgentContext;

describe("defineAgent tool execution", () => {
  it("returns explicit structured tool errors as MCP isError results", async () => {
    const tool = defineTool({
      name: "secure_action",
      description: "secure action",
      input: z.object({}),
      output: z.object({}),
      execute: async () => {
        throw new StructuredToolError({
          code: "needs_confirmation",
          message: "Browser action requires confirmation by actionPolicy.",
          details: {
            action: "navigate",
            target: "https://example.com",
          },
        });
      },
    });

    const result = await executeToolForMcp(tool, TEST_CONTEXT, {});

    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text) as unknown, {
      code: "needs_confirmation",
      message: "Browser action requires confirmation by actionPolicy.",
      details: {
        action: "navigate",
        target: "https://example.com",
      },
    });
  });

  it("extracts mcpImages into MCP image content blocks", async () => {
    const tool = defineTool({
      name: "capture_thing",
      description: "capture",
      input: z.object({}),
      output: z.object({
        success: z.boolean(),
        mcpImages: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
      }),
      execute: async () => ({
        success: true,
        mcpImages: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
      }),
    });

    const result = await executeToolForMcp(tool, TEST_CONTEXT, {});

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    assert.deepEqual(JSON.parse(result.content[0].text) as unknown, { success: true });
    assert.deepEqual(result.content[1], {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    });
  });

  it("keeps plain results as single text block when mcpImages is absent", async () => {
    const tool = defineTool({
      name: "plain_tool",
      description: "plain",
      input: z.object({}),
      output: z.object({ value: z.number() }),
      execute: async () => ({ value: 42 }),
    });

    const result = await executeToolForMcp(tool, TEST_CONTEXT, {});

    assert.equal(result.content.length, 1);
    assert.deepEqual(JSON.parse(result.content[0].text) as unknown, { value: 42 });
  });

  it("returns structurally compatible tool errors as MCP isError results", async () => {
    const tool = defineTool({
      name: "browser_action",
      description: "browser action",
      input: z.object({}),
      output: z.object({}),
      execute: async () => {
        const error = new Error("Browser action denied by actionPolicy.") as Error & {
          payload: {
            code: string;
            message: string;
            details: {
              action: string;
              target: string;
            };
          };
        };
        error.payload = {
          code: "action_denied",
          message: "Browser action denied by actionPolicy.",
          details: {
            action: "click",
            target: "button.submit",
          },
        };
        throw error;
      },
    });

    const result = await executeToolForMcp(tool, TEST_CONTEXT, {});

    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text) as unknown, {
      code: "action_denied",
      message: "Browser action denied by actionPolicy.",
      details: {
        action: "click",
        target: "button.submit",
      },
    });
  });

  it("passes the MCP request signal through to the tool context", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const tool = defineTool({
      name: "signal_probe",
      description: "signal probe",
      input: z.object({}),
      output: z.object({}),
      execute: async (_input, ctx) => {
        receivedSignal = ctx.signal;
        return {};
      },
    });

    await executeToolForMcp(tool, TEST_CONTEXT, {}, controller.signal);

    assert.equal(receivedSignal, controller.signal);
  });

  it("keeps the tool context signal-free when no signal is provided", async () => {
    let receivedContext: AgentContext | undefined;
    const tool = defineTool({
      name: "signal_free_probe",
      description: "signal free probe",
      input: z.object({}),
      output: z.object({}),
      execute: async (_input, ctx) => {
        receivedContext = ctx;
        return {};
      },
    });

    await executeToolForMcp(tool, TEST_CONTEXT, {});

    assert.equal(receivedContext?.signal, undefined);
    assert.equal(receivedContext, TEST_CONTEXT);
  });

  it("publishes annotations and resource hints through MCP listTools", async () => {
    const tool = defineTool({
      name: "write_file",
      description: "write a file",
      input: z.object({ path: z.string() }),
      output: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
      resourceHints: [{ field: "path", kind: "file", mode: "write" }],
      _meta: { owner: "sdk-test" },
      execute: async () => ({ ok: true }),
    });
    const server = new McpServer({ name: "sdk-resource-test", version: "0.0.1" });
    registerTool(server, tool, TEST_CONTEXT);
    const client = new Client({ name: "sdk-resource-test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = (await client.listTools()).tools.find((item) => item.name === "write_file");
      assert.ok(listed);
      assert.equal(listed.annotations?.destructiveHint, true);
      assert.deepEqual(listed._meta, {
        owner: "sdk-test",
        "roll/resourceHints": [{ field: "path", kind: "file", mode: "write" }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("resolveAgentLogLevel", () => {
  const originalLogLevel = process.env["ROLL_AGENT_LOG_LEVEL"];

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env["ROLL_AGENT_LOG_LEVEL"];
      return;
    }
    process.env["ROLL_AGENT_LOG_LEVEL"] = originalLogLevel;
  });

  it("defaults to info without env override", () => {
    delete process.env["ROLL_AGENT_LOG_LEVEL"];

    assert.equal(resolveAgentLogLevel(), "info");
  });

  it("uses ROLL_AGENT_LOG_LEVEL when explicit level is absent", () => {
    process.env["ROLL_AGENT_LOG_LEVEL"] = "warn";

    assert.equal(resolveAgentLogLevel(), "warn");
  });

  it("keeps explicit log level above env override", () => {
    process.env["ROLL_AGENT_LOG_LEVEL"] = "warn";

    assert.equal(resolveAgentLogLevel("debug"), "debug");
  });
});

describe("opt-in appOutput MCP contract", () => {
  async function withClient(
    tool: Parameters<typeof registerTool>[1],
    check: (client: Client) => Promise<void>,
  ) {
    const server = new McpServer({ name: "app-output-test", version: "1" });
    registerTool(server, tool, TEST_CONTEXT);
    const client = new Client({ name: "app-output-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await check(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("publishes an output schema and complete structuredContent only for opted-in tools", async () => {
    const data = { candidates: [{ name: "张三", score: 0.8 }], empty: {} };
    await withClient(
      defineTool({
        name: "candidates",
        description: "synthetic candidates",
        input: z.object({}),
        output: z.object({
          candidates: z.array(z.object({ name: z.string(), score: z.number() })),
          empty: z.object({}),
        }),
        appOutput: { schemaId: "test.candidates", schemaVersion: 1 },
        execute: async () => data,
      }),
      async (client) => {
        const listed = (await client.listTools()).tools[0];
        assert.equal(listed?.outputSchema?.type, "object");
        assert.deepEqual(listed?._meta?.["roll/appOutput"], {
          schemaId: "test.candidates",
          schemaVersion: 1,
          remoteReadable: false,
        });
        const result = await client.callTool({ name: "candidates", arguments: {} });
        assert.deepEqual(result.structuredContent, data);
        assert.equal(result.isError, undefined);
      },
    );
  });

  it("retains completed execution evidence when output validation fails after a side effect", async () => {
    let count = 0;
    const malformed: unknown = { count: "bad" };
    await withClient(
      {
        name: "effect",
        description: "effect",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        appOutput: { schemaId: "test.effect", schemaVersion: 1 },
        execute: async () => {
          count += 1;
          return malformed;
        },
      },
      async (client) => {
        await client.listTools(); // Ensures automatic MCP output validation is active.
        const result = await client.callTool({ name: "effect", arguments: {} });
        assert.equal(count, 1);
        assert.equal(result.structuredContent, undefined);
        assert.deepEqual(result._meta, {
          "roll/appOutputStatus": "invalid",
          "roll/executionStatus": "completed",
        });
      },
    );
  });

  it("does not truncate oversized data or silently strip undeclared properties", async () => {
    for (const [data, expected] of [
      [{ value: "字".repeat(100000) }, "too_large"],
      [{ value: "ok", secret: "private" }, "invalid"],
    ] as const) {
      const tool = {
        name: "result",
        description: "result",
        input: z.object({}),
        output: z.object({ value: z.string() }),
        appOutput: { schemaId: "test.result", schemaVersion: 1 },
        execute: async () => data,
      };
      const result = await executeToolForMcp(tool, TEST_CONTEXT, {});
      assert.equal(result._meta?.["roll/appOutputStatus"], expected);
      assert.equal(result.structuredContent, undefined);
      assert.ok(!result.content[0].text.includes("private"));
    }
  });

  it("rejects unrepresentable nested transformations before business execution", async () => {
    let count = 0;
    const tool = defineTool({
      name: "transform",
      description: "transform",
      input: z.object({}),
      output: z.object({ name: z.string().transform((v) => v.trim()) }),
      appOutput: { schemaId: "test.transform", schemaVersion: 1 },
      execute: async () => {
        count += 1;
        return { name: "name" };
      },
    });
    const server = new McpServer({ name: "transform", version: "1" });
    assert.throws(() => registerTool(server, tool, TEST_CONTEXT), /cannot represent/);
    await assert.rejects(executeToolForMcp(tool, TEST_CONTEXT, {}), /cannot represent/);
    assert.equal(count, 0);
  });

  it("leaves legacy tool results text-only even when output validation would fail", async () => {
    await withClient(
      {
        name: "legacy",
        description: "legacy",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        execute: async () => ({ count: "historically unchecked" }),
      },
      async (client) => {
        const listed = (await client.listTools()).tools[0];
        assert.equal(listed?.outputSchema, undefined);
        const result = await client.callTool({ name: "legacy", arguments: {} });
        assert.equal(result.structuredContent, undefined);
        assert.equal(result._meta, undefined);
        assert.equal(result.isError, undefined);
      },
    );
  });
});
