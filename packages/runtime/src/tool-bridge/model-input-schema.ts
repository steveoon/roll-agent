import { asSchema, jsonSchema, type FlexibleSchema, type Schema } from "ai";
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider";

function hasDisjointDiscriminator(branches: readonly JSONSchema7Definition[]): boolean {
  const first = branches[0];
  if (first === undefined || typeof first === "boolean") return false;
  return (
    first.required?.some((name) => {
      const values = new Set<string>();
      return branches.every((branch) => {
        if (
          typeof branch === "boolean" ||
          branch.type !== "object" ||
          branch.$ref !== undefined ||
          !branch.required?.includes(name)
        ) {
          return false;
        }
        const property = branch.properties?.[name];
        if (
          property === undefined ||
          typeof property === "boolean" ||
          property.$ref !== undefined ||
          typeof property.const !== "string" ||
          values.has(property.const)
        ) {
          return false;
        }
        values.add(property.const);
        return true;
      });
    }) ?? false
  );
}

function normalizeDefinition(schema: JSONSchema7Definition): JSONSchema7Definition {
  return typeof schema === "boolean" ? schema : normalizeObjectUnions(schema);
}

function normalizeObjectUnions(schema: JSONSchema7): JSONSchema7 {
  const result = { ...schema };
  // Visit schema positions only: examples/defaults and properties named "oneOf" are data.
  for (const key of ["properties", "patternProperties", "definitions"] as const) {
    const children = schema[key];
    if (children !== undefined) {
      result[key] = Object.fromEntries(
        Object.entries(children).map(([name, child]) => [name, normalizeDefinition(child)]),
      );
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const children = schema[key];
    if (children !== undefined) result[key] = children.map(normalizeDefinition);
  }
  if (schema.items !== undefined) {
    result.items = Array.isArray(schema.items)
      ? schema.items.map(normalizeDefinition)
      : normalizeDefinition(schema.items);
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
    if (child !== undefined) result[key] = normalizeDefinition(child);
  }
  // Zod 4 emits oneOf for discriminated unions. OpenAI accepts anyOf instead.
  // Only rewrite provably exclusive object branches; general oneOf is not equivalent.
  if (
    result.oneOf !== undefined &&
    result.anyOf === undefined &&
    hasDisjointDiscriminator(result.oneOf)
  ) {
    result.anyOf = result.oneOf;
    delete result.oneOf;
  }
  return result;
}

function isAsyncSchema(
  schema: JSONSchema7 | PromiseLike<JSONSchema7>,
): schema is PromiseLike<JSONSchema7> {
  return "then" in schema && typeof schema.then === "function";
}

/** Keep the original validator/transforms, projecting only the schema sent to the model. */
export function modelToolInputSchema<Input>(input: FlexibleSchema<Input>): Schema<Input> {
  const schema = asSchema(input);
  return jsonSchema(
    () => {
      const wire = schema.jsonSchema;
      return isAsyncSchema(wire) ? wire.then(normalizeObjectUnions) : normalizeObjectUnions(wire);
    },
    schema.validate === undefined ? {} : { validate: schema.validate },
  );
}
