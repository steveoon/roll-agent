import { z } from "zod";
import { rollConfigSchema } from "./schema.ts";

export type KeyCodecNode =
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, KeyCodecNode>> }
  | { readonly kind: "record"; readonly value: KeyCodecNode }
  | { readonly kind: "array"; readonly item: KeyCodecNode }
  | { readonly kind: "leaf" };

const LEAF: KeyCodecNode = { kind: "leaf" };

/**
 * 从 Zod schema 派生 YAML key 编码树。
 *
 * object 字段使用 kebab-case；record 的动态 key 和 array 的索引保持原样。
 * 这让新增普通 Roll 配置字段无需再维护第二份 key 清单。
 */
export function buildKeyCodecNode(schema: z.ZodTypeAny): KeyCodecNode {
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodObject) {
    const fields = Object.fromEntries(
      Object.entries(unwrapped.shape).map(([key, child]) => {
        if (!(child instanceof z.ZodType)) {
          throw new Error(`Unsupported Zod object field: ${key}`);
        }
        return [key, buildKeyCodecNode(child)];
      }),
    );
    return { kind: "object", fields };
  }

  if (unwrapped instanceof z.ZodRecord) {
    return { kind: "record", value: buildKeyCodecNode(unwrapped.valueSchema) };
  }

  if (unwrapped instanceof z.ZodArray) {
    return { kind: "array", item: buildKeyCodecNode(unwrapped.element) };
  }

  return LEAF;
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

function buildConfigKeyCodec(): Extract<KeyCodecNode, { readonly kind: "object" }> {
  const codec = buildKeyCodecNode(rollConfigSchema);
  if (codec.kind !== "object") {
    throw new Error("rollConfigSchema root must be an object");
  }
  return codec;
}

export const CONFIG_KEY_CODEC = buildConfigKeyCodec();

export function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeFromYaml(value: unknown, node: KeyCodecNode = CONFIG_KEY_CODEC): unknown {
  if (Array.isArray(value)) {
    const itemNode = node.kind === "array" ? node.item : node;
    return value.map((item) => decodeFromYaml(item, itemNode));
  }
  if (!isRecord(value)) {
    return value;
  }

  if (node.kind === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const camelKey = kebabToCamel(key);
      const childNode = node.fields[camelKey] ?? LEAF;
      result[camelKey] = decodeFromYaml(child, childNode);
    }
    return result;
  }

  if (node.kind === "record") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = decodeFromYaml(child, node.value);
    }
    return result;
  }

  return value;
}

/**
 * 将运行时使用的 camelCase 配置对象编码为持久化 YAML 使用的 kebab-case 结构。
 *
 * `record` 节点的用户键必须原样保留，例如 provider 名、Agent 名以及
 * `runtime.approval.overrides` 中可能包含英文句点的完整 tool name。
 */
export function encodeToYaml(value: unknown, node: KeyCodecNode = CONFIG_KEY_CODEC): unknown {
  if (Array.isArray(value)) {
    const itemNode = node.kind === "array" ? node.item : node;
    return value.map((item) => encodeToYaml(item, itemNode));
  }
  if (!isRecord(value)) {
    return value;
  }

  if (node.kind === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childNode = node.fields[key] ?? LEAF;
      result[camelToKebab(key)] = encodeToYaml(child, childNode);
    }
    return result;
  }

  if (node.kind === "record") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = encodeToYaml(child, node.value);
    }
    return result;
  }

  return value;
}

function walkUserPath(
  parts: readonly string[],
  objectKeyOutput: "camel" | "kebab",
  root: KeyCodecNode,
): string[] {
  const result: string[] = [];
  let current = root;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (current.kind === "object") {
      const camelKey = kebabToCamel(part);
      const childNode = current.fields[camelKey];
      if (childNode) {
        result.push(objectKeyOutput === "camel" ? camelKey : camelToKebab(camelKey));
        current = childNode;
      } else {
        result.push(part);
        current = LEAF;
      }
    } else if (current.kind === "record") {
      const recordValue = current.value;
      if (recordValue.kind === "leaf") {
        result.push(parts.slice(index).join("."));
        break;
      }

      if (recordValue.kind === "object") {
        const fieldIndex = parts.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > index && recordValue.fields[kebabToCamel(candidate)] !== undefined,
        );
        if (fieldIndex > index) {
          result.push(parts.slice(index, fieldIndex).join("."));
          current = recordValue;
          index = fieldIndex - 1;
          continue;
        }
      }

      result.push(part);
      current = recordValue;
    } else if (current.kind === "array") {
      result.push(part);
      current = current.item;
    } else {
      result.push(part);
    }
  }

  return result;
}

export function encodePathToYaml(
  parts: readonly string[],
  node: KeyCodecNode = CONFIG_KEY_CODEC,
): string[] {
  return walkUserPath(parts, "kebab", node);
}

export function normalizeUserPath(
  parts: readonly string[],
  node: KeyCodecNode = CONFIG_KEY_CODEC,
): string[] {
  return walkUserPath(parts, "camel", node);
}
