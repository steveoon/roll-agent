import type { ConfigCatalogNode, ConfigPath, JsonObject } from "../types.ts";

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAtPath(value: unknown, path: ConfigPath): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[String(segment)];
  }
  return current;
}

export function hasAtPath(value: unknown, path: ConfigPath): boolean {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      if (!(segment in current)) return false;
      current = current[segment];
      continue;
    }
    if (!isRecord(current) || !(String(segment) in current)) return false;
    current = current[String(segment)];
  }
  return true;
}

export function setAtPath(root: JsonObject, path: ConfigPath, value: unknown): JsonObject {
  if (path.length === 0) return isRecord(value) ? value : root;
  return updateRecord(root, path, 0, value);
}

export function deleteAtPath(root: JsonObject, path: ConfigPath): JsonObject {
  if (path.length === 0) return {};
  const updated = removeFromRecord(root, path, 0);
  return isRecord(updated) ? updated : {};
}

function updateRecord(
  record: JsonObject,
  path: ConfigPath,
  index: number,
  value: unknown,
): JsonObject {
  const segment = path[index];
  if (segment === undefined) return record;
  const key = String(segment);
  const next: JsonObject = { ...record };
  if (index === path.length - 1) {
    next[key] = value;
    return next;
  }

  const nextSegment = path[index + 1];
  const current = record[key];
  next[key] =
    typeof nextSegment === "number"
      ? updateArray(Array.isArray(current) ? current : [], path, index + 1, value)
      : updateRecord(isRecord(current) ? current : {}, path, index + 1, value);
  return next;
}

function updateArray(
  array: readonly unknown[],
  path: ConfigPath,
  index: number,
  value: unknown,
): readonly unknown[] {
  const segment = path[index];
  if (typeof segment !== "number") return array;
  const next = [...array];
  if (index === path.length - 1) {
    next[segment] = value;
    return next;
  }
  const nextSegment = path[index + 1];
  const current = next[segment];
  next[segment] =
    typeof nextSegment === "number"
      ? updateArray(Array.isArray(current) ? current : [], path, index + 1, value)
      : updateRecord(isRecord(current) ? current : {}, path, index + 1, value);
  return next;
}

function removeFromRecord(record: JsonObject, path: ConfigPath, index: number): unknown {
  const segment = path[index];
  if (segment === undefined) return record;
  const key = String(segment);
  const next: JsonObject = { ...record };
  if (index === path.length - 1) {
    delete next[key];
    return next;
  }
  const current = record[key];
  const child = Array.isArray(current)
    ? removeFromArray(current, path, index + 1)
    : isRecord(current)
      ? removeFromRecord(current, path, index + 1)
      : current;
  if (isEmptyContainer(child)) delete next[key];
  else next[key] = child;
  return next;
}

function removeFromArray(array: readonly unknown[], path: ConfigPath, index: number): unknown {
  const segment = path[index];
  if (typeof segment !== "number") return array;
  const next = [...array];
  if (index === path.length - 1) {
    next.splice(segment, 1);
    return next;
  }
  const current = next[segment];
  const child = Array.isArray(current)
    ? removeFromArray(current, path, index + 1)
    : isRecord(current)
      ? removeFromRecord(current, path, index + 1)
      : current;
  if (isEmptyContainer(child)) next.splice(segment, 1);
  else next[segment] = child;
  return next;
}

function isEmptyContainer(value: unknown): boolean {
  return (
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

export function defaultValueForNode(node: ConfigCatalogNode): unknown {
  if (node.defaultValue !== undefined) return structuredClone(node.defaultValue);
  switch (node.kind) {
    case "object":
    case "record":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "number":
      return 0;
    case "enum":
      return node.options[0] ?? "";
    case "string":
      return "";
    case "unknown":
      return null;
  }
}

export function formatPath(path: ConfigPath): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${String(segment)}]` : `${index === 0 ? "" : "."}${segment}`,
    )
    .join("");
}

export function matchesCatalogSearch(node: ConfigCatalogNode, query: string): boolean {
  if (query.length === 0) return true;
  if (matchesCatalogNodeSelf(node, query)) return true;
  if (node.kind === "object") {
    return Object.values(node.fields).some((child) => matchesCatalogSearch(child, query));
  }
  if (node.kind === "record") return matchesCatalogSearch(node.value, query);
  if (node.kind === "array") return matchesCatalogSearch(node.item, query);
  return false;
}

export function matchesCatalogNodeSelf(node: ConfigCatalogNode, query: string): boolean {
  if (query.length === 0) return true;
  return [
    node.title,
    node.description ?? "",
    node.defaultBehavior ?? "",
    node.example ?? "",
    node.setupCommand ?? "",
    node.path.join("."),
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function cloneObject(value: JsonObject): JsonObject {
  return structuredClone(value);
}
