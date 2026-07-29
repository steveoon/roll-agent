import { createInterface } from "node:readline";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcConnection, JsonRpcId, JsonRpcMessage } from "../protocol.ts";

export const STDIO_MAX_FRAME_BYTES = 4 * 1_024 * 1_024;

export interface StdioConnectionOptions {
  readonly maxFrameBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function requestId(value: unknown): JsonRpcId | null {
  return isRecord(value) && isJsonRpcId(value.id) ? value.id : null;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return false;
  }
  if ("method" in value) {
    if (typeof value.method !== "string" || value.method.length === 0) {
      return false;
    }
    return !("id" in value) || isJsonRpcId(value.id);
  }
  if ("result" in value) {
    return isJsonRpcId(value.id) && !("error" in value);
  }
  return (
    (value.id === null || isJsonRpcId(value.id)) &&
    isRecord(value.error) &&
    typeof value.error.code === "number" &&
    Number.isInteger(value.error.code) &&
    typeof value.error.message === "string"
  );
}

export function createStdioConnection(
  input: Readable,
  output: Writable,
  options: StdioConnectionOptions = {},
): JsonRpcConnection {
  const messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const reader = createInterface({ input });
  const maxFrameBytes = options.maxFrameBytes ?? STDIO_MAX_FRAME_BYTES;
  let writeQueue = Promise.resolve();

  const enqueue = (message: JsonRpcMessage): void => {
    const frame = `${JSON.stringify(message)}\n`;
    writeQueue = writeQueue
      .then(async () => {
        if (!output.write(frame)) {
          await once(output, "drain");
        }
      })
      .catch(() => {
        reader.close();
      });
  };

  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
      enqueue({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32_600,
          message: `Invalid Request: frame exceeds ${String(maxFrameBytes)} byte limit`,
        },
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      enqueue({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_700, message: "Parse error" },
      });
      return;
    }
    if (isJsonRpcMessage(parsed)) {
      for (const handler of messageHandlers) {
        handler(parsed);
      }
      return;
    }
    enqueue({
      jsonrpc: "2.0",
      id: requestId(parsed),
      error: { code: -32_600, message: "Invalid Request" },
    });
  });

  reader.on("close", () => {
    for (const handler of closeHandlers) {
      handler();
    }
  });

  return {
    send(message) {
      enqueue(message);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      reader.close();
    },
  };
}
