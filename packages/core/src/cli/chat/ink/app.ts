import { randomUUID } from "node:crypto";
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, useInput } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import { useSession } from "./use-session.ts";
import type { HistoryItem } from "./state.ts";
import { HistoryItemView } from "./history-item.ts";
import { LiveRegion } from "./live-region.ts";
import { StatusLine } from "./status-line.ts";
import { TextPrompt } from "./text-prompt.ts";
import { ConfirmSelect } from "./confirm-select.ts";
import { SlashPopup } from "./slash-popup.ts";
import { filterCommands, SLASH_COMMANDS } from "./commands.ts";
import { cycleThinking } from "./thinking.ts";

export interface ChatAppProps {
  readonly session: AgentSession;
  readonly model: string;
  readonly contextWindow: number | undefined;
  readonly initialHistory?: readonly HistoryItem[];
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
  readonly onUserSubmit: (text: string) => void;
  readonly onExit: () => void;
}

function helpText(): string {
  return SLASH_COMMANDS.map((command) => `${command.name} — ${command.description}`).join("\n");
}

export function ChatApp(props: ChatAppProps): ReactElement {
  const { session, model, contextWindow, onUserSubmit, onExit } = props;
  const { state, submit, compact, resolveConfirm, setDraft, setThinking, commitHistory } =
    useSession(session, {
      model,
      contextWindow,
      ...(props.initialHistory ? { initialHistory: props.initialHistory } : {}),
      ...(props.initialThinkingLevel ? { initialThinkingLevel: props.initialThinkingLevel } : {}),
      ...(props.onThinkingChange ? { onThinkingChange: props.onThinkingChange } : {}),
    });

  const [selected, setSelected] = useState(0);
  const slashActive = state.phase === "idle" && state.draft.startsWith("/");
  const matches = slashActive ? filterCommands(state.draft) : [];
  const maxIndex = Math.max(matches.length - 1, 0);
  const selectedIndex = Math.min(selected, maxIndex);

  useInput((input, key) => {
    if (key.meta && input === ".") {
      setThinking(cycleThinking(state.status.thinkingLevel, 1));
    } else if (key.meta && input === ",") {
      setThinking(cycleThinking(state.status.thinkingLevel, -1));
    }
  });

  const handleSubmit = (raw: string): void => {
    const text = raw.trim();
    if (text.length === 0) {
      setDraft("");
      return;
    }
    onUserSubmit(text);
    submit(text);
  };

  const runSlash = (raw: string): void => {
    setDraft("");
    const parts = raw.trim().split(/\s+/);
    const name = parts[0] ?? "";
    const arg = (parts[1] ?? "").toLowerCase();
    const level = state.status.thinkingLevel;
    if (name === "/compact") {
      compact();
      return;
    }
    if (name === "/think") {
      if (arg === "off") {
        setThinking("off");
      } else if (arg === "on") {
        setThinking(level === "off" ? "medium" : level);
      } else {
        setThinking(level === "off" ? "medium" : "off");
      }
      return;
    }
    if (name === "/effort") {
      if (arg === "low" || arg === "medium" || arg === "high") {
        setThinking(arg);
      } else {
        commitHistory({
          kind: "notice",
          id: randomUUID(),
          text: "用法: /effort low | medium | high",
        });
      }
      return;
    }
    if (name === "/help") {
      commitHistory({ kind: "notice", id: randomUUID(), text: helpText() });
      return;
    }
    if (name === "/exit") {
      onExit();
      return;
    }
    commitHistory({ kind: "notice", id: randomUUID(), text: `未知命令 ${name}` });
  };

  const onSlashMove = (direction: 1 | -1): void => {
    setSelected((current) =>
      Math.min(Math.max(Math.min(current, maxIndex) + direction, 0), maxIndex),
    );
  };
  const onSlashComplete = (): void => {
    const command = matches[selectedIndex];
    if (command) {
      setDraft(`${command.name} `);
      setSelected(0);
    }
  };
  const onSlashRun = (): void => {
    const token = state.draft.trim().split(/\s+/, 1)[0] ?? "";
    const exact = SLASH_COMMANDS.some((command) => command.name === token);
    runSlash(exact ? state.draft : (matches[selectedIndex]?.name ?? state.draft));
  };

  const footer =
    state.phase === "confirm" && state.pendingConfirm !== undefined
      ? h(ConfirmSelect, { prompt: state.pendingConfirm.prompt, onDecide: resolveConfirm })
      : h(TextPrompt, {
          value: state.draft,
          disabled: state.phase !== "idle",
          slashActive,
          onChange: setDraft,
          onSubmit: handleSubmit,
          onSlashMove,
          onSlashComplete,
          onSlashRun,
        });

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { flexDirection: "column" },
      ...state.history.map((historyItem) => {
        const spaced = historyItem.kind === "user" || historyItem.kind === "assistant";
        const indented = historyItem.kind === "tool" || historyItem.kind === "denied";
        return h(
          Box,
          { key: historyItem.id, marginTop: spaced ? 1 : 0, marginLeft: indented ? 2 : 0 },
          h(HistoryItemView, { item: historyItem }),
        );
      }),
    ),
    h(LiveRegion, { live: state.live }),
    h(StatusLine, { status: state.status }),
    slashActive ? h(SlashPopup, { matches, selected: selectedIndex }) : null,
    footer,
  );
}
