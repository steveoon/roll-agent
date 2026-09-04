export const JSON_SCHEMA_REF_ISSUE_REASONS = {
  recursive: "recursive",
  external: "external",
  unresolvable: "unresolvable",
  siblingKeywords: "sibling-keywords",
  limit: "limit",
} as const;

export type JsonSchemaRefIssueReason =
  (typeof JSON_SCHEMA_REF_ISSUE_REASONS)[keyof typeof JSON_SCHEMA_REF_ISSUE_REASONS];

export interface JsonSchemaRefIssue {
  readonly path: string;
  readonly ref: string;
  readonly reason: JsonSchemaRefIssueReason;
}

export interface InlineJsonSchemaRefsResult<T> {
  readonly schema: T;
  readonly unresolved: readonly JsonSchemaRefIssue[];
}

const MAX_EXPANSION_DEPTH = 32;
const MAX_EXPANDED_NODES = 10_000;
const MAX_OUTPUT_BYTES = 262_144;

const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);
const DEFINITION_CONTAINER_KEYS: ReadonlySet<string> = new Set(["$defs", "definitions"]);
const ROOT_DEFINITION_REF_PATTERN = /^#\/(?:\$defs|definitions)\/[^/]+$/u;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u;

class InlineLimitExceeded extends Error {}

type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaValue(value: unknown): value is JsonObject | boolean {
  return typeof value === "boolean" || isJsonObject(value);
}

export function isRootDefinitionReference(ref: string): boolean {
  return ROOT_DEFINITION_REF_PATTERN.test(ref);
}

function decodePointerSegment(segment: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  if (/~(?![01])/u.test(decoded)) {
    return undefined;
  }
  return decoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function encodePointerSegment(segment: string): string {
  return segment.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function resolvePointer(root: unknown, ref: string): unknown {
  const pointer = ref.slice(1);
  if (pointer.length === 0) {
    return root;
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (segment === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      current = ARRAY_INDEX_PATTERN.test(segment) ? current[Number(segment)] : undefined;
    } else if (isJsonObject(current)) {
      current = Object.prototype.hasOwnProperty.call(current, segment)
        ? current[segment]
        : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

interface InlineState {
  readonly root: unknown;
  readonly unresolved: JsonSchemaRefIssue[];
  expandedNodes: number;
}

interface InlineContext {
  readonly activeRefs: readonly string[];
  readonly expansionDepth: number;
}

function classifyRef(
  ref: string,
  context: InlineContext,
  root: unknown,
): JsonSchemaRefIssueReason | undefined {
  if (!ref.startsWith("#")) {
    return JSON_SCHEMA_REF_ISSUE_REASONS.external;
  }
  if (context.activeRefs.includes(ref)) {
    return JSON_SCHEMA_REF_ISSUE_REASONS.recursive;
  }
  return isSchemaValue(resolvePointer(root, ref))
    ? undefined
    : JSON_SCHEMA_REF_ISSUE_REASONS.unresolvable;
}

function mergeAnnotations(target: JsonObject | boolean, annotations: JsonObject): JsonObject {
  if (target === true) {
    return { ...annotations };
  }
  if (target === false) {
    return { not: {}, ...annotations };
  }
  return { ...target, ...annotations };
}

function inlineObjectEntries(
  node: JsonObject,
  path: string,
  context: InlineContext,
  state: InlineState,
): JsonObject {
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      DEFINITION_CONTAINER_KEYS.has(key)
        ? value
        : inlineNode(value, `${path}/${encodePointerSegment(key)}`, context, state),
    ]),
  );
}

function inlineNode(
  node: unknown,
  path: string,
  context: InlineContext,
  state: InlineState,
): unknown {
  if (context.activeRefs.length > 0) {
    state.expandedNodes += 1;
    if (state.expandedNodes > MAX_EXPANDED_NODES || context.expansionDepth > MAX_EXPANSION_DEPTH) {
      throw new InlineLimitExceeded();
    }
  }
  if (Array.isArray(node)) {
    return node.map((item, index) => inlineNode(item, `${path}/${String(index)}`, context, state));
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const { $ref: ref, ...siblings } = node;
  if (typeof ref !== "string") {
    return inlineObjectEntries(node, path, context, state);
  }
  if (Object.keys(siblings).some((key) => !ANNOTATION_KEYWORDS.has(key))) {
    state.unresolved.push({ path, ref, reason: JSON_SCHEMA_REF_ISSUE_REASONS.siblingKeywords });
    return node;
  }
  const issue = classifyRef(ref, context, state.root);
  if (issue !== undefined) {
    state.unresolved.push({ path, ref, reason: issue });
    return node;
  }
  const expansion: InlineState = {
    root: state.root,
    unresolved: [],
    expandedNodes: state.expandedNodes,
  };
  const target = inlineNode(
    resolvePointer(state.root, ref),
    path,
    { activeRefs: [...context.activeRefs, ref], expansionDepth: context.expansionDepth + 1 },
    expansion,
  );
  state.expandedNodes = expansion.expandedNodes;
  const recursesIntoItself = expansion.unresolved.some(
    (candidate) =>
      candidate.reason === JSON_SCHEMA_REF_ISSUE_REASONS.recursive && candidate.ref === ref,
  );
  if (recursesIntoItself) {
    state.unresolved.push({ path, ref, reason: JSON_SCHEMA_REF_ISSUE_REASONS.recursive });
    return node;
  }
  state.unresolved.push(...expansion.unresolved);
  return isSchemaValue(target) ? mergeAnnotations(target, siblings) : node;
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function inlineAcyclicLocalJsonSchemaReferences<T extends object>(
  schema: T,
): InlineJsonSchemaRefsResult<T> {
  const serialized = JSON.stringify(schema);
  if (!serialized.includes('"$ref"')) {
    return { schema, unresolved: [] };
  }
  const state: InlineState = { root: schema, unresolved: [], expandedNodes: 0 };
  try {
    const inlined = inlineNode(schema, "", { activeRefs: [], expansionDepth: 0 }, state) as T;
    const expandedBytes = utf8Bytes(inlined);
    if (expandedBytes > MAX_OUTPUT_BYTES && expandedBytes > Buffer.byteLength(serialized, "utf8")) {
      throw new InlineLimitExceeded();
    }
    return { schema: inlined, unresolved: state.unresolved };
  } catch (error) {
    if (error instanceof InlineLimitExceeded) {
      return {
        schema,
        unresolved: [{ path: "", ref: "#", reason: JSON_SCHEMA_REF_ISSUE_REASONS.limit }],
      };
    }
    throw error;
  }
}
