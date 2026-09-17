import { z } from "zod/v4";

/** Independent of a renderer and of the lossy model/display projections. */
export const APP_OUTPUT_META_KEY = "roll/appOutput";
export const APP_OUTPUT_STATUS_META_KEY = "roll/appOutputStatus";
export const APP_OUTPUT_LIMITS = {
  resultBytes: 256 * 1024,
  schemaBytes: 32 * 1024,
  threadBytes: 16 * 1024 * 1024,
  threadRecords: 2000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

const appOutputDeclarationObjectSchema = z
  .object({
    schemaId: z.string().min(1).max(256),
    schemaVersion: z.number().int().positive(),
    remoteReadable: z.boolean().default(false),
  })
  .strict();
export const appOutputDeclarationSchema = appOutputDeclarationObjectSchema.readonly();
export type AppOutputDeclaration = z.infer<typeof appOutputDeclarationSchema>;

export const appOutputContractSchema = z
  .object({
    ...appOutputDeclarationObjectSchema.shape,
    outputSchema: z.record(z.string(), z.json()),
  })
  .strict()
  .readonly();
export type AppOutputContract = z.infer<typeof appOutputContractSchema>;

export const APP_OUTPUT_UNAVAILABLE_STATUSES = [
  "not_provided",
  "invalid",
  "too_large",
  "expired",
  "denied",
] as const;
export const appOutputRejectionSchema = z
  .object({
    status: z.literal("rejected"),
    reason: z.enum(["credential_field", "credential_value"]),
    field: z.string().max(64).optional(),
  })
  .strict()
  .readonly();
export type AppOutputRejection = z.infer<typeof appOutputRejectionSchema>;

export const appOutputResultSchema = z
  .discriminatedUnion("status", [
    appOutputRejectionSchema,
    z
      .object({
        status: z.literal("available"),
        schemaId: z.string().min(1).max(256),
        schemaVersion: z.number().int().positive(),
        remoteReadable: z.boolean(),
        data: z.record(z.string(), z.json()),
        fallbackText: z.string().max(4096),
      })
      .strict(),
    z.object({ status: z.enum(APP_OUTPUT_UNAVAILABLE_STATUSES) }).strict(),
  ])
  .readonly();
export type AppOutputResult = z.infer<typeof appOutputResultSchema>;

export const appOutputDescriptorSchema = z
  .discriminatedUnion("status", [
    appOutputRejectionSchema,
    z
      .object({
        status: z.literal("available"),
        schemaId: z.string().min(1).max(256),
        schemaVersion: z.number().int().positive(),
      })
      .strict(),
    z.object({ status: z.enum(APP_OUTPUT_UNAVAILABLE_STATUSES) }).strict(),
  ])
  .readonly();
export type AppOutputDescriptor = z.infer<typeof appOutputDescriptorSchema>;

export function describeAppOutput(result: AppOutputResult): AppOutputDescriptor {
  if (result.status === "rejected") return result;
  return result.status === "available"
    ? { status: result.status, schemaId: result.schemaId, schemaVersion: result.schemaVersion }
    : { status: result.status };
}

/** Validate portable, self-contained contracts without dereferencing network resources. */
export function validateAppOutputContract(value: unknown): AppOutputContract {
  const contract = appOutputContractSchema.parse(value);
  const schema = contract.outputSchema;
  if (schema.type !== "object") throw new Error("appOutput outputSchema must be an object schema");
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > APP_OUTPUT_LIMITS.schemaBytes) {
    throw new Error("appOutput outputSchema exceeds 32 KiB");
  }
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record: Record<string, unknown> = { ...node };
    if ("$dynamicRef" in record || "$recursiveRef" in record) {
      throw new Error("appOutput supports only static local references");
    }
    if ("$ref" in record) {
      const ref = record["$ref"];
      if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) {
        throw new Error("appOutput outputSchema only supports local JSON Pointer references");
      }
      let target: unknown = schema;
      for (const part of ref === "#" ? [] : ref.slice(2).split("/")) {
        const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
        if (typeof target !== "object" || target === null || !Object.hasOwn(target, key)) {
          throw new Error("appOutput outputSchema has an unresolved local reference");
        }
        target = Reflect.get(target, key);
      }
      if (
        typeof target !== "boolean" &&
        (typeof target !== "object" || target === null || Array.isArray(target))
      ) {
        throw new Error("appOutput local reference must target a schema");
      }
    }
    for (const key of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
      "dependencies",
    ]) {
      const children = record[key];
      if (typeof children === "object" && children !== null && !Array.isArray(children)) {
        for (const child of Object.values(children)) visit(child);
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = record[key];
      if (Array.isArray(children)) children.forEach(visit);
    }
    for (const key of [
      "additionalProperties",
      "additionalItems",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "propertyNames",
      "unevaluatedProperties",
      "unevaluatedItems",
    ]) {
      visit(record[key]);
    }
    const items = record["items"];
    if (Array.isArray(items)) items.forEach(visit);
    else visit(items);
    // A nested identifier can change the meaning of otherwise local references.
    if (node !== schema && ("$id" in record || "id" in record)) {
      throw new Error("appOutput does not support nested schema identifiers");
    }
  };
  visit(schema);
  return contract;
}

/** MCP uses isError for invalid output even when execution has completed. */
export const COMPLETED_APP_OUTPUT_STATUSES = ["invalid", "too_large"] as const;
export type CompletedAppOutputStatus = (typeof COMPLETED_APP_OUTPUT_STATUSES)[number];
export function getCompletedAppOutputStatus(value: unknown): CompletedAppOutputStatus | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("isError" in value) ||
    value.isError !== true ||
    !("_meta" in value)
  ) {
    return undefined;
  }
  const meta = value._meta;
  if (
    typeof meta !== "object" ||
    meta === null ||
    !("roll/executionStatus" in meta) ||
    meta["roll/executionStatus"] !== "completed" ||
    !(APP_OUTPUT_STATUS_META_KEY in meta)
  ) {
    return undefined;
  }
  const status = meta[APP_OUTPUT_STATUS_META_KEY];
  return status === "invalid" || status === "too_large" ? status : undefined;
}
