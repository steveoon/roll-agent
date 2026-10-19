import type { ThreadStore } from "@roll-agent/runtime";
import { messagesToHistory } from "./history-from-messages.ts";
import type { HistoryItem } from "./state.ts";

const HISTORY_PAGE_SIZE = 50;
const ERROR_OUTPUT_TYPES = new Set(["error-text", "error-json", "execution-denied"]);

export type TranscriptHistoryStore = Pick<
  ThreadStore,
  "listRecentTranscriptMessages" | "listToolExecutions" | "getTranscriptCompleteness"
>;

export interface TranscriptHistoryPage {
  readonly items: readonly HistoryItem[];
  readonly nextBeforeSequence: number | undefined;
}

export interface TranscriptHistoryReader {
  readonly legacy: boolean;
  readonly read: (beforeSequence?: number) => TranscriptHistoryPage;
}

export type TranscriptHistorySource = (threadId: string) => TranscriptHistoryReader;

/** A display-only snapshot. New turns are rendered by useSession, never read back into this prefix. */
export function createTranscriptHistorySource(
  store: TranscriptHistoryStore,
): TranscriptHistorySource {
  return (threadId) => {
    const latest = store.listRecentTranscriptMessages(threadId, { limit: 1 });
    const upperBound = (latest.entries[0]?.sequence ?? -1) + 1;
    let knownResults = new Map<string, boolean>();
    return {
      legacy: store.getTranscriptCompleteness(threadId) === "legacy_snapshot",
      read: (beforeSequence = upperBound) => {
        const page = store.listRecentTranscriptMessages(threadId, {
          beforeSequence: Math.min(beforeSequence, upperBound),
          limit: HISTORY_PAGE_SIZE,
        });
        // Newer pages contain the results of calls whose requests may be in an older page.
        // Publish this cache only after the entire page was converted successfully.
        const results = new Map(knownResults);
        for (const { message } of page.entries) {
          if (message.role !== "tool" || typeof message.content === "string") continue;
          for (const part of message.content) {
            if (part.type === "tool-result") {
              results.set(part.toolCallId, !ERROR_OUTPUT_TYPES.has(part.output.type));
            }
          }
        }
        const items = messagesToHistory(
          page.entries.map((entry) => entry.message),
          "transcript",
          {
            messageId: (index) => `transcript:${threadId}:${String(page.entries[index]?.sequence)}`,
            toolOutcome: (toolCallId) => {
              const known = results.get(toolCallId);
              if (known !== undefined) return known;
              const record = store.listToolExecutions(threadId, { toolCallId, limit: 1 })[0];
              return record === undefined ? undefined : record.outcome.kind === "success";
            },
          },
        );
        knownResults = results;
        return { items, nextBeforeSequence: page.nextBeforeSequence };
      },
    };
  };
}
