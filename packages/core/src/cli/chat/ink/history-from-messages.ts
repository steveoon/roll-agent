import type { ModelMessage } from "ai";
import { readTurnCancellationReason, SUMMARY_ACK, SUMMARY_PREFIX } from "@roll-agent/runtime";
import { formatToolInput } from "../../utils/tool-format.ts";
import { GLYPHS } from "../../utils/glyphs.ts";
import type { HistoryItem } from "./state.ts";

const ERROR_OUTPUT_TYPES = new Set(["error-text", "error-json", "execution-denied"]);

function textFromContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function toolDisplayName(toolName: string): string {
  const index = toolName.indexOf("__");
  return index >= 0 ? `${toolName.slice(0, index)}.${toolName.slice(index + 2)}` : toolName;
}

export function messagesToHistory(
  messages: readonly ModelMessage[],
  idPrefix = "h",
): HistoryItem[] {
  const resultOk = new Map<string, boolean>();
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-result") {
        const outputType: string = part.output.type;
        resultOk.set(part.toolCallId, !ERROR_OUTPUT_TYPES.has(outputType));
      }
    }
  }

  const items: HistoryItem[] = [];
  messages.forEach((message, messageIndex) => {
    const id = `${idPrefix}-${String(messageIndex)}`;
    if (message.role === "user") {
      const text = textFromContent(message.content);
      if (text.startsWith(SUMMARY_PREFIX)) {
        items.push({ kind: "compaction", id, notice: `${GLYPHS.compact} 已恢复的上下文摘要` });
        return;
      }
      if (text.length > 0) {
        items.push({ kind: "user", id, text });
      }
      return;
    }
    if (message.role === "assistant") {
      const text = textFromContent(message.content);
      if (text.startsWith(SUMMARY_ACK)) {
        return;
      }
      if (text.length > 0) {
        const cancellationReason = readTurnCancellationReason(message);
        items.push(
          cancellationReason
            ? { kind: "turn-cancelled", id, text, reason: cancellationReason }
            : { kind: "assistant", id, text },
        );
      }
      if (typeof message.content !== "string") {
        message.content.forEach((part, partIndex) => {
          if (part.type === "tool-call") {
            items.push({
              kind: "tool",
              id: `${id}-${String(partIndex)}`,
              name: toolDisplayName(part.toolName),
              args: formatToolInput(part.input),
              ok: resultOk.get(part.toolCallId) ?? true,
            });
          }
        });
      }
    }
  });
  return items;
}
