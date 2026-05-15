import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRunToolResultForJsonOutput } from "./run.ts";

describe("run command result formatting", () => {
  it("unwraps structured MCP tool errors for single-call JSON output", () => {
    const result = formatRunToolResultForJsonOutput({
      index: 0,
      agent: "browser-use-agent",
      tool: "zhipin_send_prepared_reply",
      ok: false,
      error: "tool 返回 isError=true",
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "needs_confirmation",
              message: "Tool execution requires confirmation by browser-use tool policy.",
              details: {
                reason: "tool_policy_confirm",
                approvalRequest: {
                  id: "approval-1",
                  retryInput: {
                    toolActionApproval: {
                      id: "approval-1",
                    },
                  },
                },
              },
            }),
          },
        ],
      },
    });

    assert.deepEqual(result, {
      index: 0,
      agent: "browser-use-agent",
      tool: "zhipin_send_prepared_reply",
      ok: false,
      error: "tool 返回 isError=true",
      result: {
        code: "needs_confirmation",
        message: "Tool execution requires confirmation by browser-use tool policy.",
        details: {
          reason: "tool_policy_confirm",
          approvalRequest: {
            id: "approval-1",
            retryInput: {
              toolActionApproval: {
                id: "approval-1",
              },
            },
          },
        },
      },
    });
  });
});
