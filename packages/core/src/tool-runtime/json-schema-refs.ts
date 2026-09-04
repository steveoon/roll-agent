export const JSON_SCHEMA_REF_ISSUE_REASONS = {
  recursive: "recursive",
  external: "external",
  unresolvable: "unresolvable",
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

const MAX_INLINE_DEPTH = 32;
const MAX_VISITED_NODES = 10_000;
const MAX_OUTPUT_BYTES = 262_144;

class InlineLimitExceeded extends Error {}

type JsonObject = Readonly<Record<string, unknown>>;

const DEFINITION_CONTAINER_KEYS: ReadonlySet<string> = new Set(["$defs", "definitions"]);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
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
  visited: number;
}

function classifyRef(
  ref: string,
  activeRefs: readonly string[],
  root: unknown,
): JsonSchemaRefIssueReason | undefined {
  if (!ref.startsWith("#")) {
    return JSON_SCHEMA_REF_ISSUE_REASONS.external;
  }
  if (activeRefs.includes(ref)) {
    return JSON_SCHEMA_REF_ISSUE_REASONS.recursive;
  }
  return isJsonObject(resolvePointer(root, ref))
    ? undefined
    : JSON_SCHEMA_REF_ISSUE_REASONS.unresolvable;
}

function inlineObjectEntries(
  node: JsonObject,
  path: string,
  activeRefs: readonly string[],
  depth: number,
  state: InlineState,
): JsonObject {
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      DEFINITION_CONTAINER_KEYS.has(key)
        ? value
        : inlineNode(value, `${path}/${encodePointerSegment(key)}`, activeRefs, depth + 1, state),
    ]),
  );
}

function inlineNode(
  node: unknown,
  path: string,
  activeRefs: readonly string[],
  depth: number,
  state: InlineState,
): unknown {
  state.visited += 1;
  if (state.visited > MAX_VISITED_NODES || depth > MAX_INLINE_DEPTH) {
    throw new InlineLimitExceeded();
  }
  if (Array.isArray(node)) {
    return node.map((item, index) =>
      inlineNode(item, `${path}/${String(index)}`, activeRefs, depth + 1, state),
    );
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const { $ref: ref, ...siblings } = node;
  if (typeof ref !== "string") {
    return inlineObjectEntries(node, path, activeRefs, depth, state);
  }
  const issue = classifyRef(ref, activeRefs, state.root);
  if (issue !== undefined) {
    state.unresolved.push({ path, ref, reason: issue });
    return { $ref: ref, ...inlineObjectEntries(siblings, path, activeRefs, depth, state) };
  }
  const expansion: InlineState = { root: state.root, unresolved: [], visited: state.visited };
  const target = inlineNode(
    resolvePointer(state.root, ref),
    path,
    [...activeRefs, ref],
    depth + 1,
    expansion,
  );
  state.visited = expansion.visited;
  const inlinedSiblings = inlineObjectEntries(siblings, path, activeRefs, depth, state);
  const recursesIntoItself = expansion.unresolved.some(
    (issue) => issue.reason === JSON_SCHEMA_REF_ISSUE_REASONS.recursive && issue.ref === ref,
  );
  if (recursesIntoItself) {
    state.unresolved.push({ path, ref, reason: JSON_SCHEMA_REF_ISSUE_REASONS.recursive });
    return { $ref: ref, ...inlinedSiblings };
  }
  state.unresolved.push(...expansion.unresolved);
  return isJsonObject(target) ? { ...target, ...inlinedSiblings } : inlinedSiblings;
}

export function inlineAcyclicLocalJsonSchemaReferences<T extends object>(
  schema: T,
): InlineJsonSchemaRefsResult<T> {
  const state: InlineState = { root: schema, unresolved: [], visited: 0 };
  try {
    const inlined = inlineNode(schema, "", [], 0, state) as T;
    if (JSON.stringify(inlined).length > MAX_OUTPUT_BYTES) {
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
