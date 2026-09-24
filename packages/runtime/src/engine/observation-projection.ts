import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type { ObservationRetentionDeclaration } from "@roll-agent/protocol/observation-retention";
import type { ToolModelOutput } from "../tool-bridge/normalize-result.ts";

type JsonRecord = Record<string, unknown>;

export interface Observation {
  readonly page: JsonRecord;
  readonly snapshot: JsonRecord;
  readonly identity: string;
  readonly resource: string;
  readonly complete: boolean;
}

// Leave room below the generic tool model limit for the enclosing tool-call message.
const MAX_OBSERVATION_MODEL_CHARS = 50_000;
const MAX_NODE_CHARS = 40_000;

interface ProjectionBudget {
  remaining: number;
  truncated: boolean;
  omittedNodes: number;
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseObservation(value: unknown): Observation | undefined {
  if (!record(value) || !record(value.page) || !record(value.snapshot)) {
    return undefined;
  }
  const snapshot = value.snapshot;
  if (
    !nonempty(snapshot.browserInstance) ||
    !nonempty(snapshot.pageId) ||
    !nonempty(snapshot.documentId) ||
    !Array.isArray(snapshot.nodes) ||
    !Array.isArray(snapshot.refs) ||
    (snapshot.truncated !== true && snapshot.truncated !== false)
  ) {
    return undefined;
  }
  const warnings = Array.isArray(snapshot.coverageWarnings) ? snapshot.coverageWarnings : [];
  return {
    page: value.page,
    snapshot,
    identity: JSON.stringify([snapshot.browserInstance, snapshot.pageId, snapshot.documentId]),
    resource: JSON.stringify([snapshot.browserInstance, snapshot.pageId]),
    complete: snapshot.truncated === false && !nonempty(snapshot.scope) && warnings.length === 0,
  };
}

/** Read only successful, fully structured observations. Errors and clipped JSON are untouched. */
export function observationFromMcpRaw(
  raw: unknown,
  declaration: ObservationRetentionDeclaration | undefined,
): Observation | undefined {
  if (declaration?.kind !== "browser-ax-snapshot" || !record(raw) || raw.isError === true) {
    return undefined;
  }
  if (record(raw.structuredContent)) {
    const structured = parseObservation(raw.structuredContent);
    if (structured) return structured;
  }
  if (!Array.isArray(raw.content)) return undefined;
  for (const part of raw.content) {
    if (!record(part) || part.type !== "text" || typeof part.text !== "string") continue;
    try {
      const parsed = parseObservation(JSON.parse(part.text));
      if (parsed) return parsed;
    } catch {
      // A failed or previously clipped result is not a replaceable observation.
    }
  }
  return undefined;
}

export function observationFromModelOutput(output: unknown): Observation | undefined {
  if (!record(output)) return undefined;
  if (output.type === "json") return parseObservation(output.value);
  if (output.type !== "content" || !Array.isArray(output.value)) return undefined;
  for (const part of output.value) {
    if (!record(part) || part.type !== "text" || typeof part.text !== "string") continue;
    try {
      const parsed = parseObservation(JSON.parse(part.text));
      if (parsed) return parsed;
    } catch {
      // Preserve malformed and clipped historical results verbatim.
    }
  }
  return undefined;
}

function boundedValue(
  value: unknown,
  maxChars: number,
  budget: ProjectionBudget,
  depth = 0,
): JSONValue {
  if (typeof value === "string") {
    const limit = Math.min(1_024, Math.max(0, maxChars - 16));
    if (value.length <= limit) return value;
    budget.truncated = true;
    return `${value.slice(0, limit)}[省略]`;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 5) {
    budget.truncated = true;
    return "[嵌套内容省略]";
  }
  if (Array.isArray(value)) {
    const result: JSONValue[] = [];
    for (const item of value.slice(0, 24)) {
      const candidate = boundedValue(
        item,
        maxChars - JSON.stringify(result).length,
        budget,
        depth + 1,
      );
      if (JSON.stringify([...result, candidate]).length > maxChars) {
        budget.truncated = true;
        break;
      }
      result.push(candidate);
    }
    if (result.length < value.length) budget.truncated = true;
    return result;
  }
  if (record(value)) {
    const result: Record<string, JSONValue> = {};
    // JSON omits undefined object properties; absence is not lost evidence.
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    for (const [key, item] of entries.slice(0, 24)) {
      const safeKey = key.slice(0, 128);
      if (safeKey !== key) budget.truncated = true;
      const candidate = boundedValue(
        item,
        maxChars - JSON.stringify(result).length,
        budget,
        depth + 1,
      );
      if (JSON.stringify({ ...result, [safeKey]: candidate }).length > maxChars) {
        budget.truncated = true;
        break;
      }
      result[safeKey] = candidate;
    }
    if (Object.keys(result).length < entries.length) budget.truncated = true;
    return result;
  }
  budget.truncated = true;
  return null;
}

function compactNode(
  value: unknown,
  refs: Map<string, JsonRecord>,
  historical: boolean,
  budget: ProjectionBudget,
): JSONValue | undefined {
  if (!record(value)) {
    budget.omittedNodes += 1;
    budget.truncated = true;
    return undefined;
  }
  const { children, ref, ...fields } = value;
  const detail = typeof ref === "string" ? refs.get(ref) : undefined;
  const refDetails = detail
    ? Object.fromEntries(
        Object.entries(detail).filter(
          ([key, item]) =>
            key !== "ref" &&
            item !== undefined &&
            (fields[key] === undefined || JSON.stringify(fields[key]) !== JSON.stringify(item)),
        ),
      )
    : undefined;
  const node = boundedValue(
    {
      ...(!historical && ref !== undefined ? { ref } : {}),
      ...(fields.role !== undefined ? { role: fields.role } : {}),
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.frameId !== undefined ? { frameId: fields.frameId } : {}),
      ...(fields.depth !== undefined ? { depth: fields.depth } : {}),
      ...fields,
      ...(!historical && refDetails && Object.keys(refDetails).length > 0 ? { refDetails } : {}),
    },
    2_500,
    budget,
  );
  if (!record(node)) return undefined;
  const baseChars = JSON.stringify(node).length + 16;
  if (baseChars > budget.remaining) {
    budget.omittedNodes += 1;
    budget.truncated = true;
    return undefined;
  }
  budget.remaining -= baseChars;
  if (Array.isArray(children)) {
    const compactChildren: JSONValue[] = [];
    for (const child of children) {
      const compact = compactNode(child, refs, historical, budget);
      if (compact !== undefined) compactChildren.push(compact);
    }
    if (compactChildren.length > 0) return { ...node, children: compactChildren } as JSONValue;
  }
  return node as JSONValue;
}

function compactObservation(
  observation: Observation,
  historical = false,
  resultId?: string,
): ToolModelOutput {
  const snapshot = observation.snapshot;
  const budget: ProjectionBudget = {
    remaining: MAX_NODE_CHARS,
    truncated: false,
    omittedNodes: 0,
  };
  const refs = new Map<string, JsonRecord>();
  for (const value of snapshot.refs as unknown[]) {
    if (record(value) && nonempty(value.ref)) refs.set(value.ref, value);
  }
  const nodes = (snapshot.nodes as unknown[]).flatMap((node) => {
    const compact = compactNode(node, refs, historical, budget);
    return compact === undefined ? [] : [compact];
  });
  const seen = new Set<string>();
  const visit = (values: readonly unknown[]): void => {
    for (const value of values) {
      if (!record(value)) continue;
      if (nonempty(value.ref)) seen.add(value.ref);
      if (Array.isArray(value.children)) visit(value.children);
    }
  };
  visit(snapshot.nodes as unknown[]);
  const unmatchedRefs = historical
    ? []
    : [...refs]
        .filter(([ref]) => !seen.has(ref))
        .map(([, value]) => value)
        .slice(0, 16);
  if (!historical && unmatchedRefs.length < [...refs].filter(([ref]) => !seen.has(ref)).length) {
    budget.truncated = true;
  }
  const { refs: _refs, nodes: _nodes, ...metadata } = snapshot;
  const page = boundedValue(observation.page, 2_000, budget);
  const boundedMetadata = boundedValue(
    {
      snapshotId: snapshot.snapshotId,
      browserInstance: snapshot.browserInstance,
      pageId: snapshot.pageId,
      documentId: snapshot.documentId,
      scope: snapshot.scope,
      truncated: snapshot.truncated,
      coverageWarnings: snapshot.coverageWarnings,
      ...metadata,
    },
    5_000,
    budget,
  );
  const boundedUnmatchedRefs = boundedValue(unmatchedRefs, 1_000, budget);
  const value = {
    ...(resultId ? { resultId } : {}),
    page,
    snapshot: {
      ...(record(boundedMetadata) ? boundedMetadata : {}),
      nodes,
      ...(Array.isArray(boundedUnmatchedRefs) && boundedUnmatchedRefs.length > 0
        ? { unmatchedRefs: boundedUnmatchedRefs }
        : {}),
      ...(historical ? { historicalEvidenceOnly: true, refsAreStale: true } : {}),
      ...(budget.truncated
        ? {
            modelProjectionTruncated: true,
            modelProjectionOmittedNodes: budget.omittedNodes,
            modelProjectionWarning: "模型侧观察已省略部分内容；可按结果 ID 分页回查原始观察",
          }
        : {}),
    },
  };
  // A structural safety valve for unusually large metadata or escaped text. Remove whole nodes.
  while (JSON.stringify(value).length > MAX_OBSERVATION_MODEL_CHARS && nodes.length > 0) {
    nodes.pop();
    budget.omittedNodes += 1;
    budget.truncated = true;
    Object.assign(value.snapshot, {
      modelProjectionTruncated: true,
      modelProjectionOmittedNodes: budget.omittedNodes,
      modelProjectionWarning: "模型侧观察已省略部分内容；可按结果 ID 分页回查原始观察",
    });
  }
  return {
    type: "json",
    value: value as JSONValue,
  };
}

/** Model-only output; SDK/MCP raw output and canonical step results are not changed. */
export function currentObservationModelOutput(
  raw: unknown,
  declaration: ObservationRetentionDeclaration | undefined,
): ToolModelOutput | undefined {
  const observation = observationFromMcpRaw(raw, declaration);
  return observation ? compactObservation(observation) : undefined;
}

/** Complete original MCP content for canonical step persistence, including large snapshots. */
export function canonicalObservationOutput(
  raw: unknown,
  declaration: ObservationRetentionDeclaration | undefined,
): ToolModelOutput | undefined {
  if (!observationFromMcpRaw(raw, declaration) || !record(raw)) return undefined;
  const structured = record(raw.structuredContent)
    ? parseObservation(raw.structuredContent)
    : undefined;
  const content = raw.content;
  if (Array.isArray(content)) {
    const texts = content.flatMap((part) =>
      record(part) && part.type === "text" && typeof part.text === "string"
        ? [{ type: "text" as const, text: part.text }]
        : [],
    );
    if (texts.length > 0) {
      if (!structured) return { type: "content", value: texts };
      try {
        if (
          JSON.stringify(JSON.parse(texts[0]?.text ?? "")) === JSON.stringify(raw.structuredContent)
        ) {
          return { type: "content", value: texts };
        }
      } catch {
        // structuredContent remains the complete canonical value.
      }
    }
  }
  return structured ? { type: "json", value: raw.structuredContent as JSONValue } : undefined;
}

export interface ObservationProjectionOptions {
  readonly declarations: ReadonlyMap<string, ObservationRetentionDeclaration>;
  readonly resultId?: (toolCallId: string) => string | undefined;
  readonly recallToolId?: string;
}

/** Pure model-visible projection. It neither mutates input messages nor drops tool-result pairs. */
export function projectObservationMessages(
  messages: readonly ModelMessage[],
  options: ObservationProjectionOptions,
): ModelMessage[] {
  const newest = new Set<string>();
  const newestDocumentByResource = new Map<string, string>();
  const historicalComplete = new Set<string>();
  // An SDK step may emit one tool message per result. Treat the contiguous tool-result block
  // after its assistant call as one batch so parallel recalls survive the next inference together.
  const batchIds: number[] = [];
  let nextBatchId = 0;
  let inToolBatch = false;
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      if (!inToolBatch) nextBatchId += 1;
      batchIds[index] = nextBatchId;
      inToolBatch = true;
    } else {
      inToolBatch = false;
    }
  }
  let newestRecallBatch: number | undefined;
  let laterUserTurn = false;
  return [...messages]
    .reverse()
    .map((message, reverseIndex) => {
      if (message.role === "user") {
        laterUserTurn = true;
        return message;
      }
      if (message.role !== "tool") return message;
      const content = [...message.content].reverse().map((part) => {
        if (part.type !== "tool-result") return part;
        if (part.toolName === options.recallToolId) {
          const batchId = batchIds[messages.length - 1 - reverseIndex];
          if (
            !laterUserTurn &&
            batchId !== undefined &&
            (newestRecallBatch === undefined || newestRecallBatch === batchId)
          ) {
            newestRecallBatch = batchId;
            return part;
          }
          return {
            ...part,
            output: {
              type: "text" as const,
              value: "[历史观察回查；如需证据请按结果 ID 再次读取]",
            },
          };
        }
        const declaration = options.declarations.get(part.toolName);
        if (!declaration) return part;
        const canonical = part.output;
        const observation = observationFromModelOutput(canonical);
        if (!observation) return { ...part, output: canonical };
        const newestDocument = newestDocumentByResource.get(observation.resource);
        if (newestDocument === undefined) {
          newestDocumentByResource.set(observation.resource, observation.identity);
        }
        const staleDocument =
          newestDocument !== undefined && newestDocument !== observation.identity;
        const first = !newest.has(observation.identity);
        if (first) newest.add(observation.identity);
        if (first && !staleDocument) {
          if (observation.complete) historicalComplete.add(observation.identity);
          return {
            ...part,
            output: compactObservation(observation, false, options.resultId?.(part.toolCallId)),
          };
        }
        if (
          !staleDocument &&
          observation.complete &&
          !historicalComplete.has(observation.identity)
        ) {
          historicalComplete.add(observation.identity);
          return {
            ...part,
            output: compactObservation(observation, true, options.resultId?.(part.toolCallId)),
          };
        }
        return {
          ...part,
          output: {
            type: "json" as const,
            value: {
              historicalObservation: true,
              refsAreStale: true,
              ...(staleDocument ? { documentStale: true } : {}),
              ...(options.resultId?.(part.toolCallId)
                ? { resultId: options.resultId(part.toolCallId) }
                : {}),
              snapshotId:
                typeof observation.snapshot.snapshotId === "string"
                  ? observation.snapshot.snapshotId
                  : null,
              browserInstance: String(observation.snapshot.browserInstance),
              pageId: String(observation.snapshot.pageId),
              documentId: String(observation.snapshot.documentId),
              scope:
                typeof observation.snapshot.scope === "string" ? observation.snapshot.scope : null,
              truncated: observation.snapshot.truncated === true,
              coverageWarnings: Array.isArray(observation.snapshot.coverageWarnings)
                ? observation.snapshot.coverageWarnings.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
            } satisfies JSONValue,
          },
        };
      });
      return { ...message, content: content.reverse() };
    })
    .reverse();
}

export function restoreCanonicalObservationOutputs(
  messages: readonly ModelMessage[],
  outputs: ReadonlyMap<string, ToolModelOutput>,
): ModelMessage[] {
  return messages.map((message) =>
    message.role === "tool"
      ? {
          ...message,
          content: message.content.map((part) =>
            part.type === "tool-result" && outputs.has(part.toolCallId)
              ? { ...part, output: outputs.get(part.toolCallId)! }
              : part,
          ),
        }
      : message,
  );
}
