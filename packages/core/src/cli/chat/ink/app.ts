import { randomUUID } from "node:crypto";
import { createElement as h, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import type { ChatThinkingDisplay } from "../../../config/schema.ts";
import { diffDisplayNotice, resolveDiffDisplayToggle } from "../diff-display.ts";
import { useSession } from "./use-session.ts";
import { CHAT_PHASES, type HistoryItem } from "./state.ts";
import { StatusLine } from "./status-line.ts";
import { TextPrompt } from "./text-prompt.ts";
import { ConfirmSelect } from "./confirm-select.ts";
import { UserInputForm } from "./user-input-form.ts";
import { SlashPopup } from "./slash-popup.ts";
import { SessionPicker } from "./session-picker.ts";
import { messagesToHistory } from "./history-from-messages.ts";
import type { SessionPickerItem } from "../session-picker-format.ts";
import {
  buildSkillListLines,
  filterSlashEntries,
  isSlashCommandShaped,
  isSlashCommandToken,
  parseSkillInvocation,
  SLASH_COMMANDS,
} from "./commands.ts";
import { bannerTextLine, buildBannerLines, type BannerInfo } from "../banner.ts";
import { cycleThinking } from "./thinking.ts";
import { appendInputHistory } from "./input-history.ts";
import {
  attachmentExists,
  formatAttachmentSize,
  loadPendingAttachment,
  MAX_ATTACHMENT_BYTES,
  parsePastedImagePaths,
  type PendingChatAttachment,
} from "./paste-attachments.ts";
import { readClipboardImage } from "./clipboard-image.ts";
import { resolveTurnActivity } from "./turn-activity.ts";
import { TurnStatusLine } from "./turn-status-line.ts";
import { resolveChatLayout } from "./layout.ts";
import { TranscriptViewport } from "./transcript-viewport.ts";

export interface ChatSessionSwitching {
  readonly loadItems: (currentSessionId: string) => readonly SessionPickerItem[];
  readonly resume: (threadId: string) => Promise<AgentSession>;
  readonly onRetired: (threadId: string) => void;
}

export interface ChatAppProps {
  readonly session: AgentSession;
  readonly model: string;
  readonly initialHistory?: readonly HistoryItem[];
  readonly banner?: BannerInfo;
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly initialThinkingDisplay?: ChatThinkingDisplay;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
  readonly onUserSubmit: (text: string) => void;
  readonly onExit: () => void;
  readonly sessionSwitching?: ChatSessionSwitching;
}

interface SessionPickerState {
  readonly items: readonly SessionPickerItem[];
  readonly busy: boolean;
  readonly error?: string;
}

interface ChatSessionViewProps extends Omit<ChatAppProps, "sessionSwitching"> {
  readonly picker: SessionPickerState | undefined;
  readonly onOpenPicker: () => boolean;
  readonly onPickerSelect: (threadId: string) => void;
  readonly onPickerCancel: () => void;
}

export const INK_HINTS =
  "/exit 退出 · Esc 中断 · / 命令 · Shift+Enter/Ctrl+J 换行 · Alt+./Alt+, 调推理 · Shift+Tab 自动批准 · Ctrl+T 鼠标选择";

const SHOW_THINK_SCOPE_HINT = "（仅当前会话生效，/resume 切换会话后按配置重置）";

function helpText(): string {
  return SLASH_COMMANDS.map((command) => `${command.name} — ${command.description}`).join("\n");
}

export function ChatApp(props: ChatAppProps): ReactElement {
  const [activeSession, setActiveSession] = useState(props.session);
  const [sessionHistory, setSessionHistory] = useState<readonly HistoryItem[] | undefined>(
    props.initialHistory,
  );
  const [picker, setPicker] = useState<SessionPickerState | undefined>(undefined);
  const retiringRef = useRef<AgentSession | undefined>(undefined);
  const sessionSwitching = props.sessionSwitching;

  useEffect(() => {
    const retiring = retiringRef.current;
    if (retiring === undefined || retiring === activeSession) {
      return;
    }
    retiringRef.current = undefined;
    const finish = (): void => {
      sessionSwitching?.onRetired(retiring.id);
    };
    retiring.close().then(finish, finish);
  }, [activeSession, sessionSwitching]);

  const openPicker = useCallback((): boolean => {
    if (sessionSwitching === undefined) {
      return false;
    }
    setPicker({ items: sessionSwitching.loadItems(activeSession.id), busy: false });
    return true;
  }, [sessionSwitching, activeSession]);

  const cancelPicker = useCallback(() => {
    setPicker(undefined);
  }, []);

  const selectSession = useCallback(
    (threadId: string) => {
      if (sessionSwitching === undefined) {
        return;
      }
      setPicker((current) =>
        current === undefined ? current : { items: current.items, busy: true },
      );
      sessionSwitching.resume(threadId).then(
        (next) => {
          retiringRef.current = activeSession;
          setSessionHistory(messagesToHistory(next.getMessages()));
          setActiveSession(next);
          setPicker(undefined);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setPicker((current) =>
            current === undefined ? current : { items: current.items, busy: false, error: message },
          );
        },
      );
    },
    [sessionSwitching, activeSession],
  );

  return h(ChatSessionView, {
    key: activeSession.id,
    session: activeSession,
    model: props.model,
    onUserSubmit: props.onUserSubmit,
    onExit: props.onExit,
    ...(sessionHistory !== undefined ? { initialHistory: sessionHistory } : {}),
    ...(props.banner !== undefined ? { banner: props.banner } : {}),
    ...(props.initialThinkingLevel !== undefined
      ? { initialThinkingLevel: props.initialThinkingLevel }
      : {}),
    ...(props.initialThinkingDisplay !== undefined
      ? { initialThinkingDisplay: props.initialThinkingDisplay }
      : {}),
    ...(props.onThinkingChange !== undefined ? { onThinkingChange: props.onThinkingChange } : {}),
    picker,
    onOpenPicker: openPicker,
    onPickerSelect: selectSession,
    onPickerCancel: cancelPicker,
  });
}

function ChatSessionView(props: ChatSessionViewProps): ReactElement {
  const { session, model, onUserSubmit, onExit } = props;
  const windowSize = useWindowSize();
  const layout = resolveChatLayout(windowSize.columns, windowSize.rows);
  const contextWindow = session.getContextWindow();
  const availableSkills = session.getSkillSummaries();
  const [inputHistory, setInputHistory] = useState<readonly string[]>(() =>
    (props.initialHistory ?? []).reduce<readonly string[]>(
      (history, item) => (item.kind === "user" ? appendInputHistory(history, item.text) : history),
      [],
    ),
  );
  const rememberInput = useCallback((text: string): void => {
    setInputHistory((history) => appendInputHistory(history, text));
  }, []);
  const {
    state,
    submit,
    compact,
    cancel,
    resolveConfirm,
    resolveUserInput,
    setDraft,
    setThinking,
    setThinkingDisplay,
    setDiffDisplay,
    setAutoMode,
    toggleAutoMode,
    commitHistory,
  } = useSession(session, {
    model,
    contextWindow,
    ...(props.initialHistory ? { initialHistory: props.initialHistory } : {}),
    ...(props.initialThinkingLevel ? { initialThinkingLevel: props.initialThinkingLevel } : {}),
    ...(props.initialThinkingDisplay
      ? { initialThinkingDisplay: props.initialThinkingDisplay }
      : {}),
    ...(props.onThinkingChange ? { onThinkingChange: props.onThinkingChange } : {}),
  });

  const animateBanner = props.banner !== undefined && (props.initialHistory?.length ?? 0) === 0;
  const [bannerSettled, setBannerSettled] = useState(!animateBanner);
  const handleBannerSettled = useCallback(() => {
    setBannerSettled(true);
  }, []);
  const bannerLines =
    props.banner === undefined
      ? undefined
      : buildBannerLines(props.banner, layout.columns, { hints: INK_HINTS });
  const [selected, setSelected] = useState(0);
  const [mouseTracking, setMouseTracking] = useState(true);
  const slashActive = state.phase === CHAT_PHASES.idle && isSlashCommandShaped(state.draft);
  const slashPopupActive = slashActive && isSlashCommandToken(state.draft.split(/\s+/).at(-1) ?? "");
  const matches = slashPopupActive ? filterSlashEntries(state.draft, availableSkills) : [];
  const maxIndex = Math.max(matches.length - 1, 0);
  const selectedIndex = Math.min(selected, maxIndex);

  useInput((input, key) => {
    if (props.picker !== undefined) {
      return;
    }
    if (state.phase === CHAT_PHASES.userInput) {
      if (layout.tooSmall && key.escape && !key.meta && state.pendingUserInput !== undefined) {
        resolveUserInput(state.pendingUserInput.requestId, {
          status: "cancelled",
          reason: "用户取消",
        });
      }
      return;
    }
    if (state.phase === CHAT_PHASES.busy && key.escape && !key.meta) {
      cancel();
    } else if (key.tab && key.shift) {
      toggleAutoMode();
    } else if (key.meta && input === ".") {
      setThinking(cycleThinking(state.status.thinkingLevel, 1));
    } else if (key.meta && input === ",") {
      setThinking(cycleThinking(state.status.thinkingLevel, -1));
    } else if (key.ctrl && input === "t") {
      setMouseTracking((current) => !current);
    }
  });

  const [attachments, setAttachments] = useState<readonly PendingChatAttachment[]>([]);

  const handlePasteText = useCallback(
    (pasted: string): boolean => {
      const paths = parsePastedImagePaths(pasted);
      if (paths === undefined || !paths.every(attachmentExists)) {
        return false;
      }
      const loaded: PendingChatAttachment[] = [];
      for (const path of paths) {
        const result = loadPendingAttachment(path);
        if (result.ok) {
          loaded.push(result.attachment);
        } else {
          commitHistory({ kind: "notice", id: randomUUID(), text: result.message });
        }
      }
      if (loaded.length === 0) {
        return false;
      }
      setAttachments((current) => [...current, ...loaded]);
      return true;
    },
    [commitHistory],
  );

  const removeLastAttachment = useCallback(() => {
    setAttachments((current) => current.slice(0, -1));
  }, []);

  const [clipboardPending, setClipboardPending] = useState(false);
  const clipboardBusyRef = useRef(false);
  const clipboardCounterRef = useRef(0);
  const attachmentEpochRef = useRef(0);
  const handleClipboardImage = useCallback(() => {
    if (clipboardBusyRef.current) {
      return;
    }
    clipboardBusyRef.current = true;
    setClipboardPending(true);
    const epoch = attachmentEpochRef.current;
    const notice = (text: string): void => {
      commitHistory({ kind: "notice", id: randomUUID(), text });
    };
    readClipboardImage().then((result) => {
      clipboardBusyRef.current = false;
      setClipboardPending(false);
      if (epoch !== attachmentEpochRef.current) {
        notice("剪贴板图像在消息发送后才读取完成，已丢弃；如需附上请再按一次 Ctrl+V");
        return;
      }
      if (result.kind === "file") {
        const loaded = loadPendingAttachment(result.path);
        if (loaded.ok) {
          setAttachments((current) => [...current, loaded.attachment]);
        } else {
          notice(loaded.message);
        }
        return;
      }
      if (result.kind === "image") {
        const bytes = Buffer.from(result.data, "base64").length;
        if (bytes > MAX_ATTACHMENT_BYTES) {
          notice(
            `剪贴板图像超过 ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} 上限（实际 ${formatAttachmentSize(bytes)}）`,
          );
          return;
        }
        clipboardCounterRef.current += 1;
        setAttachments((current) => [
          ...current,
          {
            name: `剪贴板图像${String(clipboardCounterRef.current)}.png`,
            path: "",
            sizeLabel: formatAttachmentSize(bytes),
            data: result.data,
            mediaType: result.mediaType,
          },
        ]);
        return;
      }
      if (result.kind === "none") {
        notice("剪贴板中没有图像");
        return;
      }
      if (result.kind === "unsupported") {
        notice("当前平台暂不支持剪贴板图像粘贴");
        return;
      }
      notice(`读取剪贴板失败: ${result.message}`);
    });
  }, [commitHistory]);

  const handleSubmit = (raw: string): void => {
    const text = raw.trim();
    if (text.length === 0 && attachments.length === 0) {
      setDraft("");
      return;
    }
    if (text.length > 0) {
      rememberInput(text);
    }
    // banner 需先于首条消息落入 Static，否则顺序颠倒
    handleBannerSettled();
    onUserSubmit(text.length > 0 ? text : "[图片]");
    submit(text, attachments);
    attachmentEpochRef.current += 1;
    setAttachments([]);
  };

  const runSlash = (raw: string): void => {
    handleBannerSettled();
    setDraft("");
    const text = raw.trim();
    rememberInput(text);
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
    if (name === "/show-think") {
      const next: ChatThinkingDisplay =
        arg === "on" || arg === "expanded"
          ? "expanded"
          : arg === "off" || arg === "collapsed"
            ? "collapsed"
            : state.thinkingDisplay === "collapsed"
              ? "expanded"
              : "collapsed";
      setThinkingDisplay(next);
      commitHistory({
        kind: "notice",
        id: randomUUID(),
        text:
          next === "expanded"
            ? `已完成的思考将完整显示${SHOW_THINK_SCOPE_HINT}`
            : `已完成的思考将折叠为一行摘要，/show-think on 可恢复完整显示${SHOW_THINK_SCOPE_HINT}`,
      });
      return;
    }
    if (name === "/diff") {
      const next = resolveDiffDisplayToggle(arg, state.diffDisplay);
      setDiffDisplay(next);
      commitHistory({ kind: "notice", id: randomUUID(), text: diffDisplayNotice(next) });
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
      const [header, ...rows] = buildSkillListLines(availableSkills, layout.contentWidth);
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
    if (name === "/resume") {
      if (!props.onOpenPicker()) {
        commitHistory({ kind: "notice", id: randomUUID(), text: "当前界面不支持会话切换" });
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
    const invocation = parseSkillInvocation(text, availableSkills);
    if (invocation) {
      if (invocation.prompt.length === 0) {
        setDraft(`${invocation.skills.map((skill) => `/${skill.name}`).join(" ")} `);
        return;
      }
      handleSubmit(text);
      return;
    }
    commitHistory({ kind: "notice", id: randomUUID(), text: `未知命令 ${name}` });
    setDraft(text);
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
  const onSlashRun = (raw: string): void => {
    const token = raw.trim().split(/\s+/, 1)[0] ?? "";
    const exact = SLASH_COMMANDS.some((command) => command.name === token);
    const selectedEntry = matches[selectedIndex];
    if (!exact && selectedEntry?.kind === "skill") {
      const tokens = state.draft.split(/\s+/);
      tokens[tokens.length - 1] = selectedEntry.name;
      setDraft(`${tokens.join(" ")} `);
      setSelected(0);
      return;
    }
    runSlash(exact ? raw : (selectedEntry?.name ?? raw));
  };

  const footer =
    props.picker !== undefined
      ? h(SessionPicker, {
          items: props.picker.items,
          busy: props.picker.busy,
          ...(props.picker.error !== undefined ? { error: props.picker.error } : {}),
          width: layout.columns,
          maxRows: layout.promptRows + layout.popupRows,
          onSelect: props.onPickerSelect,
          onCancel: props.onPickerCancel,
        })
      : state.phase === CHAT_PHASES.confirm && state.pendingConfirm !== undefined
        ? h(ConfirmSelect, {
            prompt: state.pendingConfirm.prompt,
            args: state.pendingConfirm.args,
            ...(state.pendingConfirm.explanation !== undefined
              ? { explanation: state.pendingConfirm.explanation }
              : {}),
            ...(state.pendingConfirm.sessionGrantLabel !== undefined
              ? { sessionGrantLabel: state.pendingConfirm.sessionGrantLabel }
              : {}),
            ...(state.pendingConfirm.diff !== undefined ? { diff: state.pendingConfirm.diff } : {}),
            width: layout.columns,
            maxRows: layout.promptRows + layout.popupRows,
            onDecide: resolveConfirm,
          })
        : state.phase === CHAT_PHASES.userInput && state.pendingUserInput !== undefined
          ? h(UserInputForm, {
              key: state.pendingUserInput.requestId,
              request: state.pendingUserInput,
              width: layout.columns,
              viewportRows: layout.renderRows,
              maxRows: layout.promptRows + layout.popupRows,
              onResolve: (result) => {
                if (state.pendingUserInput !== undefined) {
                  resolveUserInput(state.pendingUserInput.requestId, result);
                }
              },
            })
          : h(TextPrompt, {
              value: state.draft,
              width: layout.columns,
              viewportRows: layout.renderRows,
              maxRows: layout.promptRows,
              showHint: layout.showHelp,
              inputHistory,
              disabled: state.phase !== CHAT_PHASES.idle,
              ...(state.phase === CHAT_PHASES.cancelling
                ? { disabledHint: "中断请求已发送，等待当前活动退出…" }
                : {}),
              slashActive,
              slashPopupActive,
              mouseTracking,
              autoApprove: state.status.autoApprove,
              attachments,
              attachmentsPending: clipboardPending,
              onChange: setDraft,
              onSubmit: handleSubmit,
              onSlashMove,
              onSlashComplete,
              onSlashRun,
              onPasteText: handlePasteText,
              onRemoveLastAttachment: removeLastAttachment,
              onRequestClipboardImage: handleClipboardImage,
            });
  const turnActivity = resolveTurnActivity(state);

  if (layout.tooSmall) {
    return h(
      Box,
      {
        width: layout.columns,
        height: layout.renderRows,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        overflow: "hidden",
      },
      h(Text, { color: "yellow", bold: true }, "终端窗口过小"),
      h(Text, { dimColor: true }, "请调整到至少 40 × 10；当前会话和草稿已保留"),
    );
  }

  return h(
    Box,
    {
      flexDirection: "column",
      width: layout.columns,
      height: layout.renderRows,
      overflow: "hidden",
    },
    h(TranscriptViewport, {
      width: layout.columns,
      history: state.history,
      live: state.live,
      mouseTracking,
      thinkingDisplay: state.thinkingDisplay,
      diffDisplay: state.diffDisplay,
      onBannerSettled: handleBannerSettled,
      animateBanner: animateBanner && !bannerSettled,
      navigationBlocked:
        state.phase === CHAT_PHASES.confirm ||
        state.phase === CHAT_PHASES.userInput ||
        slashPopupActive ||
        props.picker !== undefined,
      ...(bannerLines === undefined ? {} : { banner: bannerLines }),
    }),
    h(
      Box,
      { flexShrink: 0, marginTop: turnActivity === undefined ? 0 : 1 },
      turnActivity === undefined
        ? h(StatusLine, { status: state.status, width: layout.columns })
        : h(TurnStatusLine, { activity: turnActivity, width: layout.columns }),
    ),
    slashPopupActive
      ? h(SlashPopup, {
          matches,
          selected: selectedIndex,
          width: layout.columns,
          maxRows: layout.popupRows,
        })
      : null,
    footer,
  );
}
