/** Deliberately small JSON Schema subset: unsupported keywords fail closed. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertJsonValue(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 24) throw new Error("JSON exceeds maximum depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (
    object(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error("Unsafe JSON key");
      }
      assertJsonValue(item, depth + 1);
    }
    return;
  }
  throw new Error("Expected finite JSON value");
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  const normalize = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(normalize);
    if (object(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key] as JsonValue)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

const keywords: Record<string, readonly string[]> = {
  object: ["properties", "required", "additionalProperties"],
  string: ["minLength", "maxLength"],
  number: ["minimum", "maximum"],
  integer: ["minimum", "maximum"],
  boolean: [],
  null: [],
  array: ["items", "minItems", "maxItems"],
};

export function validateParameterSchema(
  schema: unknown,
  depth = 0,
): asserts schema is Record<string, unknown> {
  if (depth === 0) {
    assertJsonValue(schema);
    if (Buffer.byteLength(JSON.stringify(schema)) > 32_768) {
      throw new Error("Parameter schema too large");
    }
  }
  if (
    depth > 12 ||
    !object(schema) ||
    typeof schema.type !== "string" ||
    !Object.hasOwn(keywords, schema.type)
  ) {
    throw new Error("Unsupported parameter schema type/depth");
  }
  const allowed = new Set(["type", "description", "enum", ...keywords[schema.type]!]);
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  if (schema.description !== undefined && typeof schema.description !== "string") {
    throw new Error("Invalid schema description");
  }
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ]) {
    if (!min || !max) continue;
    for (const key of [min, max]) {
      const value = schema[key];
      if (
        value !== undefined &&
        (typeof value !== "number" ||
          !Number.isFinite(value) ||
          (key !== "minimum" && key !== "maximum" && (!Number.isInteger(value) || value < 0)))
      ) {
        throw new Error(`Invalid schema ${key}`);
      }
    }
    if (
      typeof schema[min] === "number" &&
      typeof schema[max] === "number" &&
      schema[min] > schema[max]
    ) {
      throw new Error("Inverted schema bounds");
    }
  }
  if (schema.type === "object") {
    if (schema.properties !== undefined && !object(schema.properties)) {
      throw new Error("Invalid properties");
    }
    const properties = object(schema.properties) ? schema.properties : {};
    for (const property of Object.values(properties)) validateParameterSchema(property, depth + 1);
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
        new Set(schema.required).size !== schema.required.length)
    ) {
      throw new Error("Invalid required properties");
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean"
    ) {
      throw new Error("additionalProperties must be boolean");
    }
  }
  if (schema.type === "array") validateParameterSchema(schema.items, depth + 1);
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100) {
      throw new Error("Invalid enum");
    }
    const withoutEnum = { ...schema };
    delete withoutEnum.enum;
    for (const item of schema.enum) checkValue(withoutEnum, item, "$enum");
  }
}

function checkValue(schema: Record<string, unknown>, value: unknown, path: string): void {
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))
  ) {
    throw new Error(`${path}: value not in enum`);
  }
  const fail = (): never => {
    throw new Error(`${path}: parameter does not match ${String(schema.type)}`);
  };
  const bounds = (size: number, min: string, max: string): void => {
    if (
      (typeof schema[min] === "number" && size < schema[min]) ||
      (typeof schema[max] === "number" && size > schema[max])
    ) {
      fail();
    }
  };
  if (schema.type === "null") {
    if (value !== null) fail();
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail();
  } else if (schema.type === "string") {
    if (typeof value !== "string") fail();
    else bounds([...value].length, "minLength", "maxLength");
  } else if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value))
    ) {
      fail();
    } else bounds(value, "minimum", "maximum");
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || !object(schema.items)) fail();
    else {
      bounds(value.length, "minItems", "maxItems");
      value.forEach((item, index) =>
        checkValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`),
      );
    }
  } else if (schema.type === "object") {
    if (!object(value)) fail();
    else {
      const properties = object(schema.properties) ? schema.properties : {};
      for (const key of Array.isArray(schema.required) ? schema.required : []) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          throw new Error(`${path}: missing ${key}`);
        }
      }
      for (const [key, item] of Object.entries(value)) {
        const child = properties[key];
        if (Object.hasOwn(properties, key) && object(child)) {
          checkValue(child, item, `${path}.${key}`);
        } else if (schema.additionalProperties === false) {
          throw new Error(`${path}: unexpected ${key}`);
        }
      }
    }
  }
}

export function validateParameters(schema: unknown, value: unknown): JsonValue {
  validateParameterSchema(schema);
  assertJsonValue(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 65_536) throw new Error("Parameters too large");
  checkValue(schema, value, "$");
  return value;
}
