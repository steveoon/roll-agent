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

export const EXTRACTION_SCHEMA_PROFILES = {
  minimalCompatible: "minimal-compatible",
} as const;

export type ExtractionSchemaProfile =
  (typeof EXTRACTION_SCHEMA_PROFILES)[keyof typeof EXTRACTION_SCHEMA_PROFILES];

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

function getSchemaProperties(
  schema: JsonSchemaNode,
): Readonly<Record<string, JsonSchemaNode>> | undefined {
  return schema.properties;
}

/**
 * Canonical extraction schema:
 * - keeps the original JSON Schema type semantics intact
 * - drops fields that cannot be reliably extracted from natural language
 * - preserves optionality via omission instead of nullable unions
 */
function toCanonicalExtractionSchema(schema: JsonSchemaNode): JsonSchemaNode | undefined {
  const schemaType = schema.type;
  const properties = getSchemaProperties(schema);

  if (schemaType === "object" && properties) {
    const requiredChildren = Array.isArray(schema.required) ? schema.required : [];
    const nextEntries = Object.entries(properties)
      .map(([key, value]) => [key, toCanonicalExtractionSchema(value)] as const)
      .filter((entry): entry is readonly [string, JsonSchemaNode] => entry[1] !== undefined);

    if (nextEntries.length === 0) {
      return undefined;
    }

    const nextProperties = Object.fromEntries(nextEntries);
    const nextRequired = requiredChildren.filter((key) => key in nextProperties);
    return {
      type: "object",
      properties: nextProperties,
      ...(nextRequired.length > 0 ? { required: nextRequired } : {}),
      additionalProperties: false,
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  if (schemaType === "object") {
    return undefined;
  }

  if (schemaType === "array" && schema.items) {
    const nextItems = toCanonicalExtractionSchema(schema.items);
    if (!nextItems) {
      return undefined;
    }

    return {
      ...schema,
      items: nextItems,
    };
  }

  if (schemaType === "array") {
    return undefined;
  }

  return schema;
}

function createEmptyObjectSchema(description?: string): JsonSchemaNode {
  return {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
    ...(description ? { description } : {}),
  };
}

function lowerCanonicalExtractionSchema(
  schema: JsonSchemaNode,
  profile: ExtractionSchemaProfile,
): JsonSchemaNode {
  switch (profile) {
    case EXTRACTION_SCHEMA_PROFILES.minimalCompatible:
      return schema;
    default:
      return schema;
  }
}

function createCanonicalToolExtractionSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const canonical = toCanonicalExtractionSchema(schema);
  if (canonical?.type === "object") {
    return canonical;
  }

  return createEmptyObjectSchema(schema.description);
}

function normalizeRootSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const rootProperties = getSchemaProperties(schema);
  if (schema.type === "object" && rootProperties) {
    return schema;
  }

  return createEmptyObjectSchema(schema.description);
}

function getCanonicalExtractionSchema(
  schema: AgentTool["inputSchema"],
  profile: ExtractionSchemaProfile,
): JsonSchemaNode {
  return normalizeRootSchema(
    lowerCanonicalExtractionSchema(
      createCanonicalToolExtractionSchema(toJsonSchemaNode(schema)),
      profile,
    ),
  );
}

function toExtractionSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const properties = getSchemaProperties(schema);

  if (schema.type === "object" && properties) {
    const requiredChildren = Array.isArray(schema.required) ? schema.required : [];
    const nextProperties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, toExtractionSchema(value)]),
    );

    return {
      type: "object",
      properties: nextProperties,
      ...(requiredChildren.length > 0 ? { required: requiredChildren } : {}),
      additionalProperties: false,
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  if (schema.type === "array" && schema.items) {
    return {
      ...schema,
      items: toExtractionSchema(schema.items),
    };
  }

  return schema;
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
  return toMutableJsonSchema(
    toExtractionSchema(
      getCanonicalExtractionSchema(schema, EXTRACTION_SCHEMA_PROFILES.minimalCompatible),
    ),
  );
}

export function normalizeExtractedToolInput(
  schema: AgentTool["inputSchema"],
  value: unknown,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeExtractedValue(toJsonSchemaNode(schema), value, true);
  return isPlainObject(normalized) ? normalized : {};
}
