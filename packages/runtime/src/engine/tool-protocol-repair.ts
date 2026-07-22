import { modelMessageSchema, type ModelMessage } from "ai";

export const ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS = {
  valid: "valid",
  repaired: "repaired",
} as const;

export type ActiveToolProtocolRepairStatus =
  (typeof ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS)[keyof typeof ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS];

export interface ActiveToolProtocolRepair {
  readonly status: ActiveToolProtocolRepairStatus;
  readonly messages: readonly ModelMessage[];
  readonly removedToolCallIds: readonly string[];
  readonly removedToolResultIds: readonly string[];
}

interface ToolPartOccurrence {
  readonly messageIndex: number;
  readonly partIndex: number;
}

interface MutableToolProtocolIndex {
  readonly calls: Map<string, ToolPartOccurrence[]>;
  readonly results: Map<string, ToolPartOccurrence[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readToolPart(
  part: unknown,
): { readonly type: "tool-call" | "tool-result"; readonly toolCallId: string } | undefined {
  if (!isRecord(part)) {
    return undefined;
  }
  if (part.type !== "tool-call" && part.type !== "tool-result") {
    return undefined;
  }
  return typeof part.toolCallId === "string" && part.toolCallId.length > 0
    ? { type: part.type, toolCallId: part.toolCallId }
    : undefined;
}

function appendOccurrence(
  target: Map<string, ToolPartOccurrence[]>,
  toolCallId: string,
  occurrence: ToolPartOccurrence,
): void {
  const occurrences = target.get(toolCallId);
  if (occurrences === undefined) {
    target.set(toolCallId, [occurrence]);
    return;
  }
  occurrences.push(occurrence);
}

function indexToolProtocol(messages: readonly ModelMessage[]): MutableToolProtocolIndex {
  const index: MutableToolProtocolIndex = {
    calls: new Map(),
    results: new Map(),
  };
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      return;
    }
    message.content.forEach((part, partIndex) => {
      const toolPart = readToolPart(part);
      if (toolPart === undefined) {
        return;
      }
      appendOccurrence(
        toolPart.type === "tool-call" ? index.calls : index.results,
        toolPart.toolCallId,
        {
          messageIndex,
          partIndex,
        },
      );
    });
  });
  return index;
}

function occursBefore(left: ToolPartOccurrence, right: ToolPartOccurrence): boolean {
  return (
    left.messageIndex < right.messageIndex ||
    (left.messageIndex === right.messageIndex && left.partIndex < right.partIndex)
  );
}

/**
 * Reconstruct a provider-safe active projection from persisted ModelMessages.
 *
 * A Tool protocol pair is retained only when its id has exactly one call, exactly
 * one later result, and no ambiguity. Every malformed id is removed as a whole;
 * choosing a duplicate occurrence would otherwise let persistence order invent
 * which external side effect the result belongs to.
 */
export function repairActiveToolProtocol(
  messages: readonly ModelMessage[],
): ActiveToolProtocolRepair {
  const index = indexToolProtocol(messages);
  const allIds = new Set([...index.calls.keys(), ...index.results.keys()]);
  const invalidIds = new Set<string>();
  for (const toolCallId of allIds) {
    const calls = index.calls.get(toolCallId) ?? [];
    const results = index.results.get(toolCallId) ?? [];
    const call = calls[0];
    const result = results[0];
    if (
      calls.length !== 1 ||
      results.length !== 1 ||
      call === undefined ||
      result === undefined ||
      !occursBefore(call, result)
    ) {
      invalidIds.add(toolCallId);
    }
  }

  if (invalidIds.size === 0) {
    return {
      status: ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.valid,
      messages: [...messages],
      removedToolCallIds: [],
      removedToolResultIds: [],
    };
  }

  const removedToolCallIds = new Set<string>();
  const removedToolResultIds = new Set<string>();
  const repaired: ModelMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      continue;
    }
    const content = message.content.filter((part) => {
      const toolPart = readToolPart(part);
      if (toolPart === undefined || !invalidIds.has(toolPart.toolCallId)) {
        return true;
      }
      (toolPart.type === "tool-call" ? removedToolCallIds : removedToolResultIds).add(
        toolPart.toolCallId,
      );
      return false;
    });
    if (content.length > 0) {
      repaired.push(modelMessageSchema.parse({ ...message, content }));
    }
  }

  return {
    status: ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.repaired,
    messages: repaired,
    removedToolCallIds: [...removedToolCallIds].sort((left, right) => left.localeCompare(right)),
    removedToolResultIds: [...removedToolResultIds].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}
