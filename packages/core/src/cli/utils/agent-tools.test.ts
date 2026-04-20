import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMissingToolMessage,
  getToolNameSuggestions,
  normalizeListedTools,
} from "./agent-tools.ts";

describe("cli/utils/agent-tools", () => {
  it("normalizes MCP listed tools into AgentTool-compatible objects", () => {
    const normalized = normalizeListedTools([
      {
        name: "ping",
        description: "health ping",
        inputSchema: {
          type: "object",
          properties: {
            dryRun: {
              type: "boolean",
            },
          },
        },
      },
      {
        name: "fallback_schema",
        inputSchema: "invalid-schema" as unknown as { readonly type: "object" },
      },
    ]);

    assert.deepEqual(normalized, [
      {
        name: "ping",
        description: "health ping",
        inputSchema: {
          type: "object",
          properties: {
            dryRun: {
              type: "boolean",
            },
          },
        },
      },
      {
        name: "fallback_schema",
        inputSchema: {
          type: "object",
        },
      },
    ]);
  });

  it("returns close tool-name suggestions for transposed or token-overlapping typos", () => {
    const tools = [
      { name: "ping" },
      { name: "zhipin_get_candidate_list" },
      { name: "zhipin_send_reply" },
    ];

    assert.deepEqual(getToolNameSuggestions("pnig", tools), ["ping"]);
    assert.deepEqual(
      getToolNameSuggestions("zhipin_get_candidates_list", tools),
      ["zhipin_get_candidate_list", "zhipin_send_reply"],
    );
    assert.deepEqual(getToolNameSuggestions("completely_different", tools), []);
  });

  it("formats a missing-tool message with suggestions and discovery guidance", () => {
    const message = formatMissingToolMessage("smoke-test-agent", "pnig", [{ name: "ping" }]);

    assert.match(message, /Tool "pnig" 不存在于 Agent "smoke-test-agent" 中/);
    assert.match(message, /Did you mean: `ping`\?/);
    assert.match(message, /可用 tools: `ping`/);
    assert.match(message, /roll agent tools smoke-test-agent/);
  });
});
