import { z } from "zod";
import { listConfigGuidanceEntries, type ConfigGuidanceEntry } from "./guidance.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { normalizeUserPath } from "./key-codec.ts";
import { rollConfigSchema } from "./schema.ts";
import { isRollConfigSecretPath } from "./secret-policy.ts";

export const CONFIG_CATALOG_NODE_KINDS = [
  "object",
  "record",
  "array",
  "string",
  "number",
  "boolean",
  "enum",
  "unknown",
] as const;
export type ConfigCatalogNodeKind = (typeof CONFIG_CATALOG_NODE_KINDS)[number];

export const CONFIG_FIELD_WIDGETS = [
  "text",
  "password",
  "url",
  "path",
  "textarea",
  "number",
  "duration",
  "switch",
  "select",
  "string-list",
  "record",
  "object",
] as const;
export type ConfigFieldWidget = (typeof CONFIG_FIELD_WIDGETS)[number];

interface ConfigCatalogNodeBase {
  readonly kind: ConfigCatalogNodeKind;
  readonly path: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly defaultBehavior?: string;
  readonly example?: string;
  readonly setupCommand?: string;
  readonly effectiveRequired: boolean;
  readonly persistedRequired: boolean;
  readonly defaultValue?: unknown;
  readonly widget: ConfigFieldWidget;
  readonly secret: boolean;
}

export interface ConfigNumberConstraints {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum: boolean;
  readonly exclusiveMaximum: boolean;
  readonly integer: boolean;
}

export interface ConfigObjectCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "object";
  readonly fields: Readonly<Record<string, ConfigCatalogNode>>;
}

export interface ConfigRecordCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "record";
  readonly value: ConfigCatalogNode;
}

export interface ConfigArrayCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "array";
  readonly item: ConfigCatalogNode;
}

export interface ConfigEnumCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "enum";
  readonly options: readonly string[];
}

export interface ConfigLeafCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "string" | "boolean" | "unknown";
}

export interface ConfigNumberCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "number";
  readonly constraints: ConfigNumberConstraints;
}

export type ConfigCatalogNode =
  | ConfigObjectCatalogNode
  | ConfigRecordCatalogNode
  | ConfigArrayCatalogNode
  | ConfigEnumCatalogNode
  | ConfigNumberCatalogNode
  | ConfigLeafCatalogNode;

export interface AgentEnvCatalogField {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly example?: string;
  readonly defaultValue?: string;
  readonly required: boolean;
  readonly type: "string" | "boolean" | "number" | "json" | "url";
  readonly widget: "text" | "password" | "url" | "number" | "switch" | "textarea";
  readonly secret: boolean;
  readonly configurable: boolean;
  readonly sourcePath?: readonly string[];
}

export interface AgentConfigCatalog {
  readonly name: string;
  readonly description: string;
  readonly ownership: RegisteredAgent["runtime"]["ownership"];
  readonly fields: readonly AgentEnvCatalogField[];
}

export interface RollConfigCatalog {
  readonly schemaVersion: 1;
  readonly root: ConfigObjectCatalogNode;
  readonly agents: readonly AgentConfigCatalog[];
}

export function buildRollConfigCatalog(agents: readonly RegisteredAgent[] = []): RollConfigCatalog {
  const root = buildCatalogNode(rollConfigSchema, [], DEFAULT_CONFIG);
  if (root.kind !== "object") {
    throw new Error("rollConfigSchema root must be an object");
  }
  return {
    schemaVersion: 1,
    root,
    agents: agents.map(buildAgentConfigCatalog),
  };
}

function buildCatalogNode(
  schema: z.ZodTypeAny,
  path: readonly string[],
  defaultValue: unknown,
): ConfigCatalogNode {
  const effectiveRequired = !schema.safeParse(undefined).success;
  const unwrapped = unwrapSchema(schema);
  const metadata = findGuidance(path);
  const base = buildNodeBase(schema, path, defaultValue, effectiveRequired, metadata);

  if (unwrapped instanceof z.ZodObject) {
    const defaultRecord = isRecord(defaultValue) ? defaultValue : {};
    const fields = Object.fromEntries(
      Object.entries(unwrapped.shape).map(([key, child]) => {
        if (!(child instanceof z.ZodType)) {
          throw new Error(`Unsupported Zod object field at ${[...path, key].join(".")}`);
        }
        return [key, buildCatalogNode(child, [...path, key], defaultRecord[key])];
      }),
    );
    return { ...base, kind: "object", widget: "object", fields };
  }

  if (unwrapped instanceof z.ZodRecord) {
    return {
      ...base,
      kind: "record",
      widget: "record",
      value: buildCatalogNode(unwrapped.valueSchema, [...path, "*"], undefined),
    };
  }

  if (unwrapped instanceof z.ZodArray) {
    return {
      ...base,
      kind: "array",
      widget: unwrapped.element instanceof z.ZodString ? "string-list" : "object",
      item: buildCatalogNode(unwrapped.element, [...path, "*"], undefined),
    };
  }

  if (unwrapped instanceof z.ZodEnum) {
    return {
      ...base,
      kind: "enum",
      widget: "select",
      options: unwrapped.options,
    };
  }

  if (unwrapped instanceof z.ZodString) {
    return { ...base, kind: "string", widget: inferStringWidget(path) };
  }
  if (unwrapped instanceof z.ZodNumber) {
    return {
      ...base,
      kind: "number",
      widget: path.at(-1)?.endsWith("Ms") === true ? "duration" : "number",
      constraints: deriveNumberConstraints(unwrapped),
    };
  }
  if (unwrapped instanceof z.ZodBoolean) {
    return { ...base, kind: "boolean", widget: "switch" };
  }
  return { ...base, kind: "unknown", widget: "textarea" };
}

function deriveNumberConstraints(schema: z.ZodNumber): ConfigNumberConstraints {
  let minimum: { readonly value: number; readonly exclusive: boolean } | undefined;
  let maximum: { readonly value: number; readonly exclusive: boolean } | undefined;

  for (const check of schema._def.checks) {
    if (check.kind === "min") {
      if (
        minimum === undefined ||
        check.value > minimum.value ||
        (check.value === minimum.value && !check.inclusive)
      ) {
        minimum = { value: check.value, exclusive: !check.inclusive };
      }
      continue;
    }
    if (
      check.kind === "max" &&
      (maximum === undefined ||
        check.value < maximum.value ||
        (check.value === maximum.value && !check.inclusive))
    ) {
      maximum = { value: check.value, exclusive: !check.inclusive };
    }
  }

  return {
    ...(minimum !== undefined ? { minimum: minimum.value } : {}),
    ...(maximum !== undefined ? { maximum: maximum.value } : {}),
    exclusiveMinimum: minimum?.exclusive ?? false,
    exclusiveMaximum: maximum?.exclusive ?? false,
    integer: schema.isInt,
  };
}

function buildNodeBase(
  schema: z.ZodTypeAny,
  path: readonly string[],
  defaultValue: unknown,
  effectiveRequired: boolean,
  metadata: ConfigGuidanceEntry | undefined,
): ConfigCatalogNodeBase {
  const resolvedDefault =
    defaultValue !== undefined ? { defaultValue } : inferSchemaDefault(schema);
  return {
    kind: "unknown",
    path,
    title: metadata?.title ?? humanizePathSegment(path.at(-1) ?? "Roll configuration"),
    ...(metadata?.purpose !== undefined ? { description: metadata.purpose } : {}),
    ...(metadata?.defaultBehavior !== undefined
      ? { defaultBehavior: metadata.defaultBehavior }
      : {}),
    ...(metadata?.example !== undefined ? { example: metadata.example } : {}),
    ...(metadata?.setupCommand !== undefined ? { setupCommand: metadata.setupCommand } : {}),
    effectiveRequired,
    persistedRequired: effectiveRequired && !("defaultValue" in resolvedDefault),
    ...resolvedDefault,
    widget: "text",
    secret: isRollConfigSecretPath(path),
  };
}

function inferSchemaDefault(schema: z.ZodTypeAny): { readonly defaultValue: unknown } | object {
  const parsed = schema.safeParse(undefined);
  return parsed.success && parsed.data !== undefined ? { defaultValue: parsed.data } : {};
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapSchema(schema.removeDefault());
  }
  if (schema instanceof z.ZodEffects) {
    return unwrapSchema(schema.innerType());
  }
  if (schema instanceof z.ZodCatch) {
    return unwrapSchema(schema.removeCatch());
  }
  if (schema instanceof z.ZodBranded) {
    return unwrapSchema(schema.unwrap());
  }
  return schema;
}

function buildAgentConfigCatalog(agent: RegisteredAgent): AgentConfigCatalog {
  const required = new Set((agent.skill.env?.required ?? []).map((field) => field.name));
  const declarations = [...(agent.skill.env?.required ?? []), ...(agent.skill.env?.optional ?? [])];
  return {
    name: agent.skill.name,
    description: agent.skill.description,
    ownership: agent.runtime.ownership,
    fields: declarations.map((declaration) => {
      const type = declaration.type ?? inferAgentEnvType(declaration.name);
      const secret = declaration.secret ?? true;
      const configurable =
        declaration.configurable ?? declaration.name !== "BROWSER_INSTANCES_JSON";
      const sourcePath =
        declaration.sourcePath ??
        (declaration.name === "BROWSER_INSTANCES_JSON" ? ["browser", "instances"] : undefined);
      return {
        name: declaration.name,
        title: humanizeEnvName(declaration.name),
        ...(declaration.purpose !== undefined ? { description: declaration.purpose } : {}),
        ...(declaration.example !== undefined ? { example: declaration.example } : {}),
        ...(declaration.default !== undefined ? { defaultValue: declaration.default } : {}),
        required: required.has(declaration.name),
        type,
        widget: inferAgentEnvWidget(type, secret),
        secret,
        configurable,
        ...(sourcePath !== undefined ? { sourcePath } : {}),
      };
    }),
  };
}

function inferAgentEnvType(name: string): AgentEnvCatalogField["type"] {
  if (name.endsWith("_JSON")) return "json";
  if (name.endsWith("_ENABLED") || name.startsWith("ENABLE_")) return "boolean";
  if (name.endsWith("_MS") || name.endsWith("_TIMEOUT")) return "number";
  if (name.endsWith("_URL") || name.endsWith("_URI")) return "url";
  return "string";
}

function inferAgentEnvWidget(
  type: AgentEnvCatalogField["type"],
  secret: boolean,
): AgentEnvCatalogField["widget"] {
  if (secret) return "password";
  switch (type) {
    case "boolean":
      return "switch";
    case "number":
      return "number";
    case "json":
      return "textarea";
    case "url":
      return "url";
    case "string":
      return "text";
  }
}

function inferStringWidget(path: readonly string[]): ConfigFieldWidget {
  if (isRollConfigSecretPath(path)) return "password";
  const leaf = path.at(-1) ?? "";
  if (/(?:Url|Uri)$/u.test(leaf)) return "url";
  if (/(?:Dir|Path)$/u.test(leaf)) return "path";
  if (leaf === "profileColor") return "text";
  return "text";
}

function findGuidance(path: readonly string[]): ConfigGuidanceEntry | undefined {
  return listConfigGuidanceEntries().find((entry) => {
    const pattern = normalizeGuidancePattern(entry.path);
    return (
      pattern.length === path.length &&
      pattern.every((segment, index) => segment === "*" || segment === path[index])
    );
  });
}

function normalizeGuidancePattern(path: string): readonly string[] {
  const parts = path.split(".");
  const normalized = normalizeUserPath(parts);
  return normalized.map((part) => (part.startsWith("<") && part.endsWith(">") ? "*" : part));
}

function humanizePathSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[-_]/gu, " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function humanizeEnvName(name: string): string {
  return name
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
