import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcConnection, JsonRpcMessage } from "../protocol.ts";

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    (value as { readonly jsonrpc: unknown }).jsonrpc === "2.0"
  );
}

export function createStdioConnection(input: Readable, output: Writable): JsonRpcConnection {
  const messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const reader = createInterface({ input });

  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (isJsonRpcMessage(parsed)) {
      for (const handler of messageHandlers) {
        handler(parsed);
      }
    }
  });

  reader.on("close", () => {
    for (const handler of closeHandlers) {
      handler();
    }
  });

  return {
    send(message) {
      output.write(`${JSON.stringify(message)}\n`);
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
