import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AgentSession } from "./agent-session.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type { SessionEvent } from "../types/events.ts";

function fixture(batch = false) {
  const input = { source: 'await page.click(page.locator("submit"));', args: { value: "one" } };
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const steps: LanguageModelV4StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-one",
        toolName: "browser__browser_execute",
        input: JSON.stringify(input),
      },
      { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-one" },
      { type: "text-delta", id: "text-one", delta: "done" },
      { type: "text-end", id: "text-one" },
      { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
    ],
  ];
  if (batch) {
    steps[0]!.splice(2, 0, {
      type: "tool-call",
      toolCallId: "call-two",
      toolName: "browser__browser_execute",
      input: JSON.stringify(input),
    });
  }
  let index = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: steps[Math.min(index++, 1)]!,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
  const calls: unknown[] = [];
  const source: AgentToolSource = {
    agentName: "browser",
    client: {
      callTool: async ({ arguments: args }: { arguments: unknown }) => {
        calls.push(structuredClone(args));
        if (calls.length === 1) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: "needs_confirmation",
                  details: {
                    executionState: "not_executed",
                    approvalRequest: {
                      id: "single-use-token",
                      tool: "browser_execute",
                      expiresAt: new Date(Date.now() + 60_000).toISOString(),
                      summary: "Run the complete script on this page",
                      retryInput: { scriptApproval: { id: "single-use-token" } },
                    },
                  },
                }),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: '{"status":"completed","executed":true}' }] };
      },
    } as unknown as Client,
    tools: [
      {
        annotations: undefined,
        tool: {
          name: "browser_execute",
          description: "Execute a program after approval",
          inputSchema: {
            type: "object",
            required: ["source", "args"],
            additionalProperties: false,
            properties: {
              source: { type: "string" },
              args: { type: "object" },
              scriptApproval: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      },
    ],
  };
  const session = new AgentSession({
    id: "tool-requested-approval",
    model,
    sources: [source],
    maxSteps: 4,
    policy: { check: () => ({ action: "allow" }) },
    turnTimeoutMs: 5000,
  });
  return { input, calls, session };
}

test("AgentSession surfaces a tool's pre-effect challenge through its real approval event and resumes once", async () => {
  const target = fixture();
  const events: SessionEvent[] = [];
  try {
    for await (const event of target.session.send("Execute the script")) {
      events.push(event);
      if (event.type === "confirmation-required") {
        assert.equal(target.calls.length, 1);
        assert.deepEqual(event.input, target.input);
        assert.equal(event.toolName, "browser_execute");
        assert.equal(event.reason, "tool_requested_confirmation");
        assert.equal(event.sessionGrantLabel, undefined);
        assert.equal(target.session.approve(event.approvalId), true);
      }
    }
    assert.equal(events.filter((event) => event.type === "confirmation-required").length, 1);
    assert.deepEqual(target.calls, [
      target.input,
      { ...target.input, scriptApproval: { id: "single-use-token" } },
    ]);
    const result = events.find((event) => event.type === "tool-result");
    assert.ok(result?.type === "tool-result");
    assert.equal(result.outcome?.kind, "success");
  } finally {
    await target.session.close();
  }
});

test("AgentSession rejection of the tool's request prevents browser execution", async () => {
  const target = fixture();
  const events: SessionEvent[] = [];
  try {
    for await (const event of target.session.send("Execute the script")) {
      events.push(event);
      if (event.type === "confirmation-required") {
        assert.equal(target.session.reject(event.approvalId, "user declined"), true);
      }
    }
    assert.equal(target.calls.length, 1);
    const result = events.find((event) => event.type === "tool-result");
    assert.ok(result?.type === "tool-result");
    assert.equal(result.outcome?.kind, "user_rejected");
  } finally {
    await target.session.close();
  }
});

test("AgentSession cancellation during the approval wait prevents late replay", async () => {
  const target = fixture();
  let approvalId: string | undefined;
  try {
    for await (const event of target.session.send("Execute the script")) {
      if (event.type === "confirmation-required") {
        approvalId = event.approvalId;
        assert.equal(target.session.cancel(), true);
      }
    }
    assert.ok(approvalId);
    assert.equal(target.session.approve(approvalId), false);
    assert.equal(target.calls.length, 1);
  } finally {
    await target.session.close();
  }
});

test("the coordinator keeps conflicting tool calls locked across approval and its continuation", async () => {
  const target = fixture(true);
  let confirmations = 0;
  try {
    for await (const event of target.session.send("Execute the batch")) {
      if (event.type === "confirmation-required") {
        confirmations++;
        assert.equal(target.calls.length, 1, "the competing call must still be queued");
        target.session.approve(event.approvalId);
      }
    }
    assert.equal(confirmations, 1);
    assert.equal(target.calls.length, 3);
    assert.deepEqual(target.calls[1], {
      ...target.input,
      scriptApproval: { id: "single-use-token" },
    });
    assert.deepEqual(target.calls[2], target.input);
  } finally {
    await target.session.close();
  }
});
