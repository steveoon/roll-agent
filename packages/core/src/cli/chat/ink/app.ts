import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Static } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import { useSession } from "./use-session.ts";
import type { HistoryItem } from "./state.ts";
import { HistoryItemView } from "./history-item.ts";
import { LiveRegion } from "./live-region.ts";
import { StatusLine } from "./status-line.ts";
import { TextPrompt } from "./text-prompt.ts";
import { ConfirmSelect } from "./confirm-select.ts";

export interface ChatAppProps {
  readonly session: AgentSession;
  readonly model: string;
  readonly contextWindow: number | undefined;
  readonly onUserSubmit: (text: string) => void;
  readonly onExit: () => void;
}

export function ChatApp({
  session,
  model,
  contextWindow,
  onUserSubmit,
  onExit,
}: ChatAppProps): ReactElement {
  const { state, submit, compact, resolveConfirm } = useSession(session, model, contextWindow);

  const handleSubmit = (raw: string): void => {
    const text = raw.trim();
    if (text.length === 0) {
      return;
    }
    if (text === "exit" || text === "quit") {
      onExit();
      return;
    }
    if (text === "/compact") {
      compact();
      return;
    }
    onUserSubmit(text);
    submit(text);
  };

  const footer =
    state.phase === "confirm" && state.pendingConfirm !== undefined
      ? h(ConfirmSelect, { prompt: state.pendingConfirm.prompt, onDecide: resolveConfirm })
      : h(TextPrompt, { disabled: state.phase !== "idle", onSubmit: handleSubmit });

  return h(
    Box,
    { flexDirection: "column" },
    h(Static, {
      items: [...state.history],
      children: (item: unknown) => {
        const historyItem = item as HistoryItem;
        const spaced = historyItem.kind === "user" || historyItem.kind === "assistant";
        const indented = historyItem.kind === "tool";
        return h(
          Box,
          {
            key: historyItem.id,
            marginTop: spaced ? 1 : 0,
            marginLeft: indented ? 2 : 0,
          },
          h(HistoryItemView, { item: historyItem }),
        );
      },
    }),
    h(LiveRegion, { live: state.live }),
    h(StatusLine, { status: state.status }),
    footer,
  );
}
