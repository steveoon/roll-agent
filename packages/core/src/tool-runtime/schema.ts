import type { AgentTool } from "../types/agent.ts";

export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonSchemaObject(value: object): value is AgentTool["inputSchema"] {
  return "type" in value && value.type === "object";
}

export function getSchemaDescription(schema: object | undefined): string | undefined {
  return schema && "description" in schema && typeof schema.description === "string"
    ? schema.description
    : undefined;
}

export function getSchemaType(schema: object | undefined): string | undefined {
  return schema && "type" in schema && typeof schema.type === "string" ? schema.type : undefined;
}

export function getSchemaEnum(schema: object | undefined): ReadonlyArray<unknown> | undefined {
  return schema && "enum" in schema && Array.isArray(schema.enum) ? schema.enum : undefined;
}

export function getSchemaItems(schema: object | undefined): object | undefined {
  return schema && "items" in schema && typeof schema.items === "object" && schema.items !== null
    ? schema.items
    : undefined;
}

export function getSchemaMinItems(schema: object | undefined): number | undefined {
  return schema && "minItems" in schema && typeof schema.minItems === "number"
    ? schema.minItems
    : undefined;
}

export function getSchemaProperties(
  schema: Pick<AgentTool, "inputSchema">["inputSchema"] | object | undefined,
): Readonly<Record<string, object>> {
  if (
    !schema ||
    !("properties" in schema) ||
    !schema.properties ||
    !isPlainObject(schema.properties)
  ) {
    return {};
  }

  const properties = Object.entries(schema.properties).filter(
    (entry): entry is [string, object] => {
      const [, value] = entry;
      return typeof value === "object" && value !== null;
    },
  );
  return Object.fromEntries(properties);
}

export function isNaturallyExtractableSchema(schema: object | undefined): boolean {
  if (!schema) {
    return false;
  }

  if (getSchemaType(schema) !== "object") {
    return true;
  }

  return Object.keys(getSchemaProperties(schema)).length > 0;
}

export function getSchemaRequired(tool: Pick<AgentTool, "inputSchema">): ReadonlyArray<string> {
  return tool.inputSchema.required ?? [];
}

export function getAdditionalPropertiesSetting(
  schema: Pick<AgentTool, "inputSchema">["inputSchema"] | object | undefined,
): boolean | undefined {
  return schema &&
    "additionalProperties" in schema &&
    typeof schema.additionalProperties === "boolean"
    ? schema.additionalProperties
    : undefined;
}

export function describeValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}
