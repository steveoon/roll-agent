import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import type { AgentContext } from "./context.ts";
import { executeToolForMcp } from "./define-agent.ts";
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
});
