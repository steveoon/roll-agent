import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  APP_OUTPUT_LIMITS,
  APP_OUTPUT_STATUS_META_KEY,
  appOutputDeclarationSchema,
  validateAppOutputContract,
  type AppOutputContract,
  type AppOutputDeclaration,
} from "@roll-agent/protocol/app-output";
import type { AnyToolDefinition } from "./types/index.ts";

// Only schemas whose validation semantics can survive the JSON Schema conversion.
// Reject effects (including custom refinements), coercion and defaulting before execution.
function assertRepresentable(schema: z.core.$ZodType, seen = new Set<z.core.$ZodType>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  for (const check of schema._zod.def.checks ?? []) {
    if (
      check._zod.def.check === "custom" ||
      check._zod.def.check === "overwrite" ||
      check._zod.def.check === "property"
    ) {
      throw new Error("appOutput cannot represent custom refinements or transformations");
    }
    if (
      check instanceof z.core.$ZodCustomStringFormat &&
      (!check._zod.def.pattern || check._zod.def.pattern.flags)
    ) {
      throw new Error("appOutput cannot represent function-based or flagged string formats");
    }
    if (
      check instanceof z.core.$ZodCheckStringFormat &&
      check._zod.def.format === "regex" &&
      check._zod.def.pattern?.flags
    ) {
      throw new Error("appOutput cannot represent regex flags");
    }
  }
  if (schema instanceof z.ZodObject) {
    for (const child of Object.values(schema.shape)) {
      if (child instanceof z.ZodType) assertRepresentable(child, seen);
    }
    const catchall = schema._zod.def.catchall;
    if (catchall !== undefined && !(catchall instanceof z.ZodNever)) {
      assertRepresentable(catchall, seen);
    }
  } else if (schema instanceof z.ZodArray) {
    assertRepresentable(schema.element, seen);
  } else if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly
  ) {
    assertRepresentable(schema.unwrap(), seen);
  } else if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) assertRepresentable(option, seen);
  } else if (schema instanceof z.ZodTuple) {
    for (const item of schema._zod.def.items) assertRepresentable(item, seen);
    if (schema._zod.def.rest) assertRepresentable(schema._zod.def.rest, seen);
  } else if (schema instanceof z.ZodRecord) {
    assertRepresentable(schema.keyType, seen);
    assertRepresentable(schema.valueType, seen);
  } else if (
    schema instanceof z.ZodString ||
    schema instanceof z.ZodNumber ||
    schema instanceof z.ZodBoolean
  ) {
    if (schema._zod.def.coerce) throw new Error("appOutput does not support coercion");
  } else if (schema instanceof z.ZodLiteral) {
    for (const value of schema.values) {
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        (typeof value !== "number" || !Number.isFinite(value))
      ) {
        throw new Error("appOutput requires JSON-compatible literals");
      }
    }
  } else if (!(schema instanceof z.ZodNull || schema instanceof z.ZodEnum)) {
    throw new Error(`appOutput cannot represent ${schema.constructor.name} as JSON Schema`);
  }
}

export function prepareAppOutput(
  tool: AnyToolDefinition,
):
  | { readonly declaration: AppOutputDeclaration; readonly contract: AppOutputContract }
  | undefined {
  if (!tool.appOutput) return undefined;
  if (!(tool.output instanceof z.ZodObject)) {
    throw new Error("appOutput requires an object output schema");
  }
  assertRepresentable(tool.output);
  const declaration = appOutputDeclarationSchema.parse(tool.appOutput);
  const contract = validateAppOutputContract({
    ...declaration,
    outputSchema: toJsonSchemaCompat(tool.output, { pipeStrategy: "output" }),
  });
  new AjvJsonSchemaValidator().getValidator(contract.outputSchema);
  return { declaration, contract };
}

function unavailable(status: "invalid" | "too_large") {
  return {
    // MCP requires isError to skip output validation when structuredContent is absent.
    // The paired marker preserves the completed execution independently of output validity.
    isError: true as const,
    _meta: {
      [APP_OUTPUT_STATUS_META_KEY]: status,
      "roll/executionStatus": "completed",
    },
    content: [
      {
        type: "text" as const,
        text: "Tool execution completed; application output unavailable. Do not repeat the operation.",
      },
    ] as [{ type: "text"; text: string }],
  };
}

export async function projectAppOutput(schema: z.ZodType, result: unknown) {
  try {
    const parsed = await schema.safeParseAsync(result);
    if (!parsed.success || !isDeepStrictEqual(parsed.data, result)) return unavailable("invalid");
    const text = JSON.stringify(result);
    if (text === undefined) return unavailable("invalid");
    if (Buffer.byteLength(text, "utf8") > APP_OUTPUT_LIMITS.resultBytes) {
      return unavailable("too_large");
    }
    const data: unknown = JSON.parse(text);
    if (
      !isDeepStrictEqual(data, result) ||
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data)
    ) {
      return unavailable("invalid");
    }
    return {
      content: [{ type: "text" as const, text }] as [{ type: "text"; text: string }],
      structuredContent: data as Record<string, unknown>,
    };
  } catch {
    // Serialization/validation must never replace evidence that execute() already completed.
    return unavailable("invalid");
  }
}
