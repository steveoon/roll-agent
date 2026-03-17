import { jsonSchema } from "ai";
import type { AgentTool } from "../types/agent.ts";
import { isPlainObject } from "./schema.ts";

type AiSdkJsonSchema = Parameters<typeof jsonSchema<Readonly<Record<string, unknown>>>>[0];
type JsonPrimitive = string | number | boolean | null;
type JsonSchemaEnumValue = JsonPrimitive;
type LocalJsonSchemaTypeName =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";
type LocalJsonSchemaDefinition = LocalJsonSchema | boolean;
type LocalJsonSchema = {
  type?: LocalJsonSchemaTypeName | LocalJsonSchemaTypeName[] | undefined;
  properties?: Record<string, LocalJsonSchemaDefinition> | undefined;
  required?: string[] | undefined;
  items?: LocalJsonSchemaDefinition | undefined;
  additionalProperties?: boolean | undefined;
  description?: string | undefined;
  enum?: JsonSchemaEnumValue[] | undefined;
};
type JsonSchemaNode = {
  readonly type?: string | readonly string[] | undefined;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly items?: JsonSchemaNode | undefined;
  readonly additionalProperties?: boolean | undefined;
  readonly description?: string | undefined;
  readonly enum?: readonly JsonSchemaEnumValue[] | undefined;
};

function toJsonSchemaNode(schema: object): JsonSchemaNode {
  const type =
    "type" in schema &&
    (typeof schema.type === "string" ||
      (Array.isArray(schema.type) && schema.type.every((item) => typeof item === "string")))
      ? (schema.type as string | readonly string[])
      : undefined;

  const properties =
    "properties" in schema && isPlainObject(schema.properties)
      ? Object.fromEntries(
          Object.entries(schema.properties).flatMap(([key, value]) =>
            isPlainObject(value) ? [[key, toJsonSchemaNode(value)] as const] : [],
          ),
        )
      : undefined;

  const required =
    "required" in schema &&
    Array.isArray(schema.required) &&
    schema.required.every((item) => typeof item === "string")
      ? schema.required
      : undefined;

  const items =
    "items" in schema && isPlainObject(schema.items) ? toJsonSchemaNode(schema.items) : undefined;
  const additionalProperties =
    "additionalProperties" in schema && typeof schema.additionalProperties === "boolean"
      ? schema.additionalProperties
      : undefined;
  const description =
    "description" in schema && typeof schema.description === "string"
      ? schema.description
      : undefined;
  const enumValues =
    "enum" in schema && Array.isArray(schema.enum)
      ? (schema.enum as readonly JsonSchemaEnumValue[])
      : undefined;

  return {
    ...(type !== undefined ? { type } : {}),
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(items !== undefined ? { items } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(enumValues !== undefined ? { enum: enumValues } : {}),
  };
}

function addNullability(schema: JsonSchemaNode): JsonSchemaNode {
  const schemaType = schema.type;
  if (typeof schemaType === "string") {
    return { ...schema, type: [schemaType, "null"] };
  }

  if (Array.isArray(schemaType) && !schemaType.includes("null")) {
    return { ...schema, type: [...schemaType, "null"] };
  }

  return schema;
}

function getSchemaProperties(
  schema: JsonSchemaNode,
): Readonly<Record<string, JsonSchemaNode>> | undefined {
  return schema.properties;
}

function toExtractionSchema(schema: JsonSchemaNode, requiredByParent: boolean): JsonSchemaNode {
  const schemaType = schema.type;
  const properties = getSchemaProperties(schema);

  if (schemaType === "object" && properties) {
    const nextProperties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const requiredChildren = Array.isArray(schema.required) ? schema.required : [];
        return [key, toExtractionSchema(value, requiredChildren.includes(key))];
      }),
    );

    const nextSchema: JsonSchemaNode = {
      ...schema,
      properties: nextProperties,
      required: Object.keys(nextProperties),
    };

    return requiredByParent ? nextSchema : addNullability(nextSchema);
  }

  if (schemaType === "array" && schema.items) {
    const nextSchema: JsonSchemaNode = {
      ...schema,
      items: toExtractionSchema(schema.items, true),
    };

    return requiredByParent ? nextSchema : addNullability(nextSchema);
  }

  return requiredByParent ? schema : addNullability(schema);
}

function toJsonSchemaTypeName(value: string): LocalJsonSchemaTypeName | undefined {
  switch (value) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
    case "array":
    case "null":
      return value;
    default:
      return undefined;
  }
}

function toJsonSchemaType(value: JsonSchemaNode["type"]): LocalJsonSchema["type"] {
  if (typeof value === "string") {
    return toJsonSchemaTypeName(value);
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => toJsonSchemaTypeName(item))
      .filter((item): item is LocalJsonSchemaTypeName => item !== undefined);
    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function toJsonSchemaDefinition(schema: JsonSchemaNode): LocalJsonSchemaDefinition {
  return toMutableJsonSchema(schema);
}

function toMutableJsonSchema(schema: JsonSchemaNode): LocalJsonSchema {
  const nextSchema: LocalJsonSchema = {
    ...(toJsonSchemaType(schema.type) !== undefined ? { type: toJsonSchemaType(schema.type) } : {}),
    ...(schema.required ? { required: [...schema.required] } : {}),
    ...(typeof schema.additionalProperties === "boolean"
      ? { additionalProperties: schema.additionalProperties }
      : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(schema.enum ? { enum: [...schema.enum] } : {}),
  };

  const properties = getSchemaProperties(schema);
  if (properties) {
    nextSchema.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, toJsonSchemaDefinition(value)]),
    );
  }

  if (schema.items) {
    nextSchema.items = toJsonSchemaDefinition(schema.items);
  }

  return nextSchema;
}

function normalizeExtractedValue(
  schema: JsonSchemaNode,
  value: unknown,
  requiredByParent: boolean,
): unknown {
  if (value === null && !requiredByParent) {
    return undefined;
  }

  const properties = getSchemaProperties(schema);

  if (schema.type === "object" && properties && isPlainObject(value)) {
    const requiredChildren = Array.isArray(schema.required) ? schema.required : [];
    const nextEntries = Object.entries(value).flatMap(([key, childValue]) => {
      const childSchema = properties[key];
      if (!childSchema) {
        return [[key, childValue] as const];
      }

      const normalized = normalizeExtractedValue(
        childSchema,
        childValue,
        requiredChildren.includes(key),
      );
      return normalized === undefined ? [] : [[key, normalized] as const];
    });
    return Object.fromEntries(nextEntries);
  }

  if (schema.type === "array" && Array.isArray(value) && isPlainObject(schema.items)) {
    return value.map((item) => normalizeExtractedValue(schema.items as JsonSchemaNode, item, true));
  }

  return value;
}

export function createExtractionSchema(schema: AgentTool["inputSchema"]): AiSdkJsonSchema {
  return toMutableJsonSchema(toExtractionSchema(toJsonSchemaNode(schema), true));
}

export function normalizeExtractedToolInput(
  schema: AgentTool["inputSchema"],
  value: unknown,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeExtractedValue(toJsonSchemaNode(schema), value, true);
  return isPlainObject(normalized) ? normalized : {};
}
