import type { UserModelMessage } from "ai";

const REDACTED_BINARY_MARKER = "[二进制数据已省略]";

export interface SessionAttachment {
  readonly data: string;
  readonly mediaType: string;
}

export interface SessionSendInput {
  readonly text: string;
  readonly attachments?: readonly SessionAttachment[];
}

export interface NormalizedSessionSendInput {
  readonly text: string;
  readonly attachments: readonly SessionAttachment[];
}

export function normalizeSessionSendInput(
  input: string | SessionSendInput,
): NormalizedSessionSendInput {
  if (typeof input === "string") {
    return { text: input, attachments: [] };
  }
  const attachments = input.attachments ?? [];
  for (const attachment of attachments) {
    if (attachment.data.length === 0) {
      throw new Error("附件 data 不能为空");
    }
    if (!attachment.mediaType.includes("/")) {
      throw new Error(`附件 mediaType 无效: "${attachment.mediaType}"`);
    }
  }
  return { text: input.text, attachments };
}

export function buildUserMessageContent(
  text: string,
  attachments: readonly SessionAttachment[],
): UserModelMessage["content"] {
  if (attachments.length === 0) {
    return text;
  }
  return [
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...attachments.map((attachment) => ({
      type: "file" as const,
      data: attachment.data,
      mediaType: attachment.mediaType,
    })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInlineBinary(value: unknown): boolean {
  return typeof value === "string" || value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function redactBinaryValue(part: unknown): unknown {
  if (!isRecord(part)) {
    return part;
  }
  if (part["type"] === "file") {
    const data = part["data"];
    if (isRecord(data) && typeof data["data"] === "string") {
      return { ...part, data: { ...data, data: REDACTED_BINARY_MARKER } };
    }
    if (isInlineBinary(data)) {
      return { ...part, data: REDACTED_BINARY_MARKER };
    }
    return part;
  }
  if (part["type"] === "image" && isInlineBinary(part["image"])) {
    return { ...part, image: REDACTED_BINARY_MARKER };
  }
  if (part["type"] === "media" && isInlineBinary(part["data"])) {
    return { ...part, data: REDACTED_BINARY_MARKER };
  }
  if (part["type"] === "tool-result") {
    const output = part["output"];
    if (isRecord(output) && output["type"] === "content" && Array.isArray(output["value"])) {
      return {
        ...part,
        output: {
          ...output,
          value: (output["value"] as readonly unknown[]).map(redactBinaryValue),
        },
      };
    }
    return part;
  }
  return part;
}

export function redactBinaryPartsForEvidence(parts: readonly unknown[]): readonly unknown[] {
  return parts.map(redactBinaryValue);
}
