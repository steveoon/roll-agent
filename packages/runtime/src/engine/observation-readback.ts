import type { ModelMessage } from "ai";
import type { ObservationRetentionDeclaration } from "@roll-agent/protocol/observation-retention";
import type { SequencedToolExecutionRecord } from "../store/thread-store.ts";
import { redactSecretText } from "../tool-bridge/tool-execution-record.ts";
import type { ObservationRecallInput } from "../tool-bridge/observation-recall-tool.ts";
import {
  observationFromMcpRaw,
  observationFromModelOutput,
  type Observation,
} from "./observation-projection.ts";

interface FlatNode {
  readonly parent: number | null;
  readonly value: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown): string | null {
  return typeof value === "string" ? redactSecretText(value).slice(0, 1_000) : null;
}

function flatten(nodes: readonly unknown[]): FlatNode[] {
  const result: FlatNode[] = [];
  const visit = (values: readonly unknown[], parent: number | null): void => {
    for (const value of values) {
      if (!record(value)) continue;
      const { children, ref: _ref, locator: _locator, ...fields } = value;
      const index = result.length;
      result.push({ parent, value: fields });
      if (Array.isArray(children)) visit(children, index);
    }
  };
  visit(nodes, null);
  return result;
}

function activeObservation(
  messages: readonly ModelMessage[],
  record: SequencedToolExecutionRecord,
): Observation | undefined {
  let match: Observation | undefined;
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool") continue;
    for (const part of [...message.content].reverse()) {
      if (part.type === "tool-result" && part.toolCallId === record.toolCallId) {
        if (match) return undefined;
        match = observationFromModelOutput(part.output);
      }
    }
  }
  return match;
}

/** Result ID was already resolved against this thread's ledger by the caller. */
export function readObservationPage(
  input: ObservationRecallInput,
  record: SequencedToolExecutionRecord,
  messages: readonly ModelMessage[],
  declaration: ObservationRetentionDeclaration,
  allowActive = true,
): unknown {
  const active = allowActive ? activeObservation(messages, record) : undefined;
  const durable =
    active || record.raw.encoding !== "json" || record.persistence?.fields.raw.truncated === true
      ? undefined
      : observationFromMcpRaw(record.raw.value, declaration);
  const observation = active ?? durable;
  if (!observation) {
    return {
      resultId: input.resultId,
      complete: false,
      reason: record.persistence?.fields.raw.truncated
        ? "durable_payload_truncated"
        : record.raw.encoding !== "json"
          ? "durable_payload_diagnostic"
          : "observation_payload_unavailable",
      refsAreStale: true,
      nodes: [],
    };
  }
  const nodes = flatten(observation.snapshot.nodes as unknown[]);
  const start = (input.afterNode ?? -1) + 1;
  const limit = input.limit ?? 8;
  const entries = nodes.slice(start, start + limit).map((node, offset) => {
    const serialized = redactSecretText(JSON.stringify(node.value));
    return {
      index: start + offset,
      parent: node.parent,
      text: serialized.slice(0, 1_500),
      ...(serialized.length > 1_500 ? { nodeTruncated: true } : {}),
    };
  });
  const nextAfterNode =
    start + entries.length < nodes.length ? start + entries.length - 1 : undefined;
  const snapshot = observation.snapshot;
  return {
    resultId: input.resultId,
    complete: true,
    source: active ? "active_history" : "durable_ledger",
    evidenceRedacted: active === undefined,
    refsAreStale: true,
    snapshotId: safeText(snapshot.snapshotId),
    browserInstance: safeText(snapshot.browserInstance),
    pageId: safeText(snapshot.pageId),
    documentId: safeText(snapshot.documentId),
    scope: safeText(snapshot.scope),
    truncated: snapshot.truncated,
    coverageWarnings: Array.isArray(snapshot.coverageWarnings)
      ? snapshot.coverageWarnings.slice(0, 16).map(safeText)
      : [],
    nodes: entries,
    ...(nextAfterNode !== undefined ? { nextAfterNode } : {}),
    totalNodes: nodes.length,
  };
}
