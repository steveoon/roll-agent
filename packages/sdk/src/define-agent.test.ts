import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import type { AgentContext } from "./context.ts";
import { executeToolForMcp, resolveAgentLogLevel } from "./define-agent.ts";
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
