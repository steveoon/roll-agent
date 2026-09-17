import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMissingToolMessage,
  formatToolSchemaIssue,
  getToolNameSuggestions,
  normalizeListedTools,
  type ToolSchemaIssue,
} from "./agent-tools.ts";

describe("cli/utils/agent-tools", () => {
  it("inlines local $ref before exposing tools and reports unresolved refs", () => {
    const issues: ToolSchemaIssue[] = [];
    const [tool] = normalizeListedTools(
      [
        {
          name: "filter",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string", minLength: 1 },
              district: { $ref: "#/properties/city", description: "区" },
              tree: { $ref: "#/$defs/node" },
            },
            $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
          },
        },
      ],
      { onSchemaIssue: (issue) => issues.push(issue) },
    );
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.properties?.district, {
      type: "string",
      minLength: 1,
      description: "区",
    });
    assert.deepEqual(tool.schemaIssues, [
      { path: "/properties/tree", ref: "#/$defs/node", reason: "recursive" },
    ]);
    assert.deepEqual(issues, [
      { toolName: "filter", path: "/properties/tree", ref: "#/$defs/node", reason: "recursive" },
    ]);
    const [first] = issues;
    assert.ok(first);
    assert.match(formatToolSchemaIssue("browser-use-agent", first), /递归引用/u);
  });

  it("omits schemaIssues when every ref was inlined", () => {
    const [tool] = normalizeListedTools([
      { name: "plain", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
    ]);
    assert.equal(tool?.schemaIssues, undefined);
  });

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
    assert.deepEqual(getToolNameSuggestions("zhipin_get_candidates_list", tools), [
      "zhipin_get_candidate_list",
      "zhipin_send_reply",
    ]);
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

describe("independent MCP appOutput discovery", () => {
  const listed = {
    name: "candidates",
    inputSchema: { type: "object" as const },
    outputSchema: { type: "object" as const, properties: { name: { type: "string" } } },
    _meta: { "roll/appOutput": { schemaId: "third-party.candidates", schemaVersion: 2 } },
  };
  it("preserves declarations and the original output schema from a non-SDK MCP server", () => {
    const [tool] = normalizeListedTools([listed]);
    assert.deepEqual(tool?.appOutput, {
      schemaId: "third-party.candidates",
      schemaVersion: 2,
      remoteReadable: false,
      outputSchema: listed.outputSchema,
    });
  });
  it("rejects missing schemas, external references and malformed declarations at discovery", () => {
    assert.throws(() =>
      normalizeListedTools([
        { name: "broken", inputSchema: { type: "object" }, _meta: listed._meta },
      ]),
    );
    assert.throws(
      () =>
        normalizeListedTools([
          {
            ...listed,
            outputSchema: {
              type: "object",
              properties: { bad: { $ref: "https://example.test/schema" } },
            },
          },
        ]),
      /local/,
    );
    assert.throws(() => normalizeListedTools([{ ...listed, _meta: { "roll/appOutput": "bad" } }]));
  });
  it("keeps an outputSchema without an explicit declaration outside the app channel", () => {
    const [tool] = normalizeListedTools([
      { name: listed.name, inputSchema: listed.inputSchema, outputSchema: listed.outputSchema },
    ]);
    assert.equal(tool?.appOutput, undefined);
  });
});
