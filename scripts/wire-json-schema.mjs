// Zod 4.6 emits oneOf for discriminated unions; keep the established wire schema spelling.
// The discriminator makes these branches disjoint, so anyOf has identical validation semantics.
export function preserveDiscriminatedUnion({ zodSchema, jsonSchema }) {
  if (zodSchema._zod.def.type === "union" && zodSchema._zod.def.discriminator !== undefined) {
    if (jsonSchema.oneOf !== undefined) {
      jsonSchema.anyOf = jsonSchema.oneOf;
      delete jsonSchema.oneOf;
    }
  }
}

// Expand compact type unions so consumers using strict Ajv can continue to compile the output.
export function expandTypeUnions(value) {
  if (value === null || typeof value !== "object") return value;
  const result = { ...value };
  if (Array.isArray(value.type)) {
    if (value.anyOf !== undefined) throw new Error("Unexpected competing JSON Schema unions");
    delete result.type;
    result.anyOf = value.type.map((type) => ({ type }));
  }
  // Only traverse schema-bearing keywords: const/default/examples may contain arbitrary JSON.
  for (const key of [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
  ]) {
    if (value[key] && typeof value[key] === "object") {
      result[key] = Object.fromEntries(
        Object.entries(value[key]).map(([name, schema]) => [name, expandTypeUnions(schema)]),
      );
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(value[key])) result[key] = value[key].map(expandTypeUnions);
  }
  for (const key of [
    "items",
    "contains",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]) {
    if (value[key] !== undefined) result[key] = expandTypeUnions(value[key]);
  }
  return result;
}
