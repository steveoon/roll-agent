import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMcpCompatibleInputSchema, parseToolInput } from "./mcp-schema.ts";

type TextContent = {
  readonly type: "text";
  readonly text: string;
};

function isTextContent(value: unknown): value is TextContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function getFirstTextContent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("content" in value)) {
    return undefined;
  }

  const content = value.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content.find(isTextContent)?.text;
}

function getIsError(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || !("isError" in value)) {
    return undefined;
  }

  return typeof value.isError === "boolean" ? value.isError : undefined;
}

test("getMcpCompatibleInputSchema exposes fields for root refined object schemas", async () => {
  const refinedInputSchema = z
    .object({
      ageMin: z.number().int().optional(),
      ageMax: z.number().int().optional(),
      gender: z.enum(["不限", "男", "女"]).default("不限"),
    })
    .refine(
      (input) =>
        input.ageMin === undefined || input.ageMax === undefined || input.ageMin <= input.ageMax,
      {
        path: ["ageMax"],
        message: "ageMax must be greater than or equal to ageMin",
      },
    );

  const server = new McpServer({ name: "schema-test", version: "0.0.1" });
  server.registerTool(
    "filter",
    {
      description: "filter candidates",
      inputSchema: getMcpCompatibleInputSchema(refinedInputSchema),
    },
    async (params) => {
      const parsedInput = await parseToolInput(refinedInputSchema, params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(parsedInput) }],
      };
    },
  );

  const client = new Client({ name: "schema-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === "filter");

    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
      "ageMax",
      "ageMin",
      "gender",
    ]);

    const validResult = await client.callTool({
      name: "filter",
      arguments: { ageMin: 20, ageMax: 40 },
    });

    const validText = getFirstTextContent(validResult);
    assert.equal(validText, JSON.stringify({ ageMin: 20, ageMax: 40, gender: "不限" }));

    const invalidResult = await client.callTool({
      name: "filter",
      arguments: { ageMin: 40, ageMax: 20 },
    });

    assert.equal(getIsError(invalidResult), true);
    const invalidText = getFirstTextContent(invalidResult);
    assert.match(invalidText ?? "", /ageMax must be greater than or equal to ageMin/);
  } finally {
    await client.close();
    await server.close();
  }
});
