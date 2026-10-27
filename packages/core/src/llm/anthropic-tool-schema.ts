import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider";

// Anthropic strict tool grammars support a subset of JSON Schema. Keep these
// constraints visible to the model in descriptions; Runtime validates the original schema.
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const LOCAL_CONSTRAINTS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern", // Only a regex subset is accepted by the grammar compiler.
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function projectDefinition(schema: JSONSchema7Definition): JSONSchema7Definition {
  return typeof schema === "boolean" ? schema : projectAnthropicStrictToolSchema(schema);
}

/** Adapt only value constraints; preserve types, unions, discriminators and object shape. */
export function projectAnthropicStrictToolSchema(schema: JSONSchema7): JSONSchema7 {
  const projected = { ...schema };
  const constraints: string[] = [];
  for (const key of LOCAL_CONSTRAINTS) {
    if (schema[key] !== undefined) {
      constraints.push(`${key}=${JSON.stringify(schema[key])}`);
      delete projected[key];
    }
  }
  if (schema.minItems !== undefined && schema.minItems !== 0 && schema.minItems !== 1) {
    constraints.push(`minItems=${schema.minItems}`);
    delete projected.minItems;
  }
  if (schema.format !== undefined && !SUPPORTED_FORMATS.has(schema.format)) {
    constraints.push(`format=${JSON.stringify(schema.format)}`);
    delete projected.format;
  }
  if (constraints.length > 0) {
    projected.description = [schema.description, `Constraints: ${constraints.join("; ")}.`]
      .filter((part) => part !== undefined && part.length > 0)
      .join("\n");
  }
  // Traverse schema positions, never examples/defaults or the names of properties.
  for (const key of ["properties", "patternProperties", "definitions"] as const) {
    const children = schema[key];
    if (children !== undefined) {
      projected[key] = Object.fromEntries(
        Object.entries(children).map(([name, child]) => [name, projectDefinition(child)]),
      );
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const children = schema[key];
    if (children !== undefined) projected[key] = children.map(projectDefinition);
  }
  if (schema.items !== undefined) {
    projected.items = Array.isArray(schema.items)
      ? schema.items.map(projectDefinition)
      : projectDefinition(schema.items);
  }
  for (const key of [
    "additionalProperties",
    "additionalItems",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ] as const) {
    const child = schema[key];
    if (child !== undefined) projected[key] = projectDefinition(child);
  }
  return projected;
}
