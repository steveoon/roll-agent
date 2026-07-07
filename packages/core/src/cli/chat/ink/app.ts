import { randomUUID } from "node:crypto";
import { createElement as h, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Box, Static, useInput } from "ink";
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
import {
  buildSkillInvocationPrompt,
  buildSkillListLines,
  filterSlashEntries,
  parseSkillInvocation,
  SLASH_COMMANDS,
  type SlashSkillSummary,
} from "./commands.ts";
import { bannerTextLine } from "../banner.ts";
import { cycleThinking } from "./thinking.ts";

export interface ChatAppProps {
  readonly session: AgentSession;
  readonly model: string;
  readonly contextWindow: number | undefined;
  readonly initialHistory?: readonly HistoryItem[];
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly availableSkills?: readonly SlashSkillSummary[];
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
  readonly onUserSubmit: (text: string) => void;
  readonly onExit: () => void;
}

function helpText(): string {
  return SLASH_COMMANDS.map((command) => `${command.name} — ${command.description}`).join("\n");
}

export function ChatApp(props: ChatAppProps): ReactElement {
  const { session, model, contextWindow, onUserSubmit, onExit } = props;
  const availableSkills = props.availableSkills ?? [];
  const {
    state,
    submit,
    compact,
    resolveConfirm,
    setDraft,
    setThinking,
    setAutoMode,
    toggleAutoMode,
    commitHistory,
  } = useSession(session, {
    model,
    contextWindow,
    ...(props.initialHistory ? { initialHistory: props.initialHistory } : {}),
    ...(props.initialThinkingLevel ? { initialThinkingLevel: props.initialThinkingLevel } : {}),
    ...(props.onThinkingChange ? { onThinkingChange: props.onThinkingChange } : {}),
  });

  const staticItems = useMemo(() => [...state.history], [state.history]);
  const [selected, setSelected] = useState(0);
  const slashActive = state.phase === "idle" && state.draft.startsWith("/");
  const slashPopupActive = slashActive && state.draft.split(/\s+/).at(-1)?.startsWith("/") === true;
  const matches = slashPopupActive ? filterSlashEntries(state.draft, availableSkills) : [];
  const maxIndex = Math.max(matches.length - 1, 0);
  const selectedIndex = Math.min(selected, maxIndex);

  useInput((input, key) => {
    if (key.tab && key.shift) {
      toggleAutoMode();
    } else if (key.meta && input === ".") {
      setThinking(cycleThinking(state.status.thinkingLevel, 1));
    } else if (key.meta && input === ",") {
      setThinking(cycleThinking(state.status.thinkingLevel, -1));
    }
  });

  const handleSubmit = (raw: string, sendText?: string): void => {
    const text = raw.trim();
    if (text.length === 0) {
      setDraft("");
      return;
    }
    onUserSubmit(text);
    submit(text, sendText);
  };

  const runSlash = (raw: string): void => {
    setDraft("");
    const text = raw.trim();
    const parts = text.split(/\s+/);
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
    if (name === "/auto") {
      if (arg === "on") {
        setAutoMode(true);
      } else if (arg === "off") {
        setAutoMode(false);
      } else {
        toggleAutoMode();
      }
      return;
    }
    if (name === "/skills") {
      const width = (process.stdout.columns || 80) - 2;
      const [header, ...rows] = buildSkillListLines(availableSkills, width);
      commitHistory({
        kind: "banner",
        id: randomUUID(),
        lines: [
          bannerTextLine(header ?? ""),
          ...rows.map((row) => bannerTextLine(row, { dim: true })),
        ],
      });
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
    const invocation = parseSkillInvocation(text, availableSkills);
    if (invocation) {
      if (invocation.prompt.length === 0) {
        setDraft(`${invocation.skills.map((skill) => `/${skill.name}`).join(" ")} `);
        return;
      }
      handleSubmit(text, buildSkillInvocationPrompt(invocation));
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
    const entry = matches[selectedIndex];
    if (entry) {
      const tokens = state.draft.split(/\s+/);
      tokens[tokens.length - 1] = entry.name;
      setDraft(`${tokens.join(" ")} `);
      setSelected(0);
    }
  };
  const onSlashRun = (): void => {
    const token = state.draft.trim().split(/\s+/, 1)[0] ?? "";
    const exact = SLASH_COMMANDS.some((command) => command.name === token);
    const selectedEntry = matches[selectedIndex];
    if (!exact && selectedEntry?.kind === "skill") {
      const tokens = state.draft.split(/\s+/);
      tokens[tokens.length - 1] = selectedEntry.name;
      setDraft(`${tokens.join(" ")} `);
      setSelected(0);
      return;
    }
    runSlash(exact ? state.draft : (selectedEntry?.name ?? state.draft));
  };

  const footer =
    state.phase === "confirm" && state.pendingConfirm !== undefined
      ? h(ConfirmSelect, {
          prompt: state.pendingConfirm.prompt,
          args: state.pendingConfirm.args,
          onDecide: resolveConfirm,
        })
      : h(TextPrompt, {
          value: state.draft,
          disabled: state.phase !== "idle",
          slashActive,
          slashPopupActive,
          autoApprove: state.status.autoApprove,
          onChange: setDraft,
          onSubmit: handleSubmit,
          onSlashMove,
          onSlashComplete,
          onSlashRun,
        });

  return h(
    Box,
    { flexDirection: "column" },
    h(Static<HistoryItem>, {
      items: staticItems,
      children: (historyItem) => {
        const spaced = historyItem.kind === "user" || historyItem.kind === "assistant";
        const indented = historyItem.kind === "tool" || historyItem.kind === "denied";
        return h(
          Box,
          { key: historyItem.id, marginTop: spaced ? 1 : 0, marginLeft: indented ? 3 : 1 },
          h(HistoryItemView, { item: historyItem }),
        );
      },
    }),
    h(Box, { marginLeft: 1 }, h(LiveRegion, { live: state.live })),
    h(StatusLine, { status: state.status }),
    slashActive ? h(SlashPopup, { matches, selected: selectedIndex }) : null,
    footer,
  );
}
