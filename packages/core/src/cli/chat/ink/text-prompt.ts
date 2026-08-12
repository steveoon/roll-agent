import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useCursor, useInput, usePaste, useStdout } from "ink";
import { GLYPHS } from "../../utils/glyphs.ts";
import { applyEditorCommand, resolveEditorCommand } from "./editor-keymap.ts";
import {
  createLineBuffer,
  insertText,
  moveVisualDown,
  moveVisualUp,
  visualLineMetrics,
} from "./line-buffer.ts";
import type { LineBufferState } from "./line-buffer.ts";
import { isMouseProtocolInput } from "./mouse-input.ts";
import { CHAT_CURSOR_REFRESH_EVENT } from "./terminal-output.ts";

const PROMPT_BORDER_WIDTH = 2;
const PROMPT_HORIZONTAL_PADDING = 4;
const PROMPT_PREFIX_WIDTH = 2;
const PROMPT_CONTENT_LEFT =
  PROMPT_BORDER_WIDTH / 2 + PROMPT_HORIZONTAL_PADDING / 2 + PROMPT_PREFIX_WIDTH;

export interface TextPromptAttachmentChip {
  readonly name: string;
  readonly sizeLabel: string;
}

export interface TextPromptProps {
  readonly value: string;
  readonly width: number;
  readonly viewportRows: number;
  readonly maxRows: number;
  /** Rows rendered below this prompt inside the viewport; keeps the cursor anchor accurate. */
  readonly bottomOffset?: number;
  readonly showHint: boolean;
  readonly inputHistory: readonly string[];
  readonly disabled: boolean;
  readonly disabledHint?: string;
  readonly slashActive: boolean;
  readonly slashPopupActive: boolean;
  readonly autoApprove: boolean;
  readonly attachments?: readonly TextPromptAttachmentChip[];
  readonly attachmentsPending?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly onSlashMove: (direction: 1 | -1) => void;
  readonly onSlashComplete: () => void;
  readonly onSlashRun: (value: string) => void;
  readonly onPasteText?: (text: string) => boolean;
  readonly onRemoveLastAttachment?: () => void;
  readonly onRequestClipboardImage?: () => void;
}

function isKeyboardProtocolResidue(input: string): boolean {
  return /^\[\?\d+u$/.test(input) || /^\x9b\?\d+u$/.test(input);
}

export function cursorPositionOf(
  lines: readonly string[],
  cursor: number,
): { row: number; col: number } {
  let remaining = cursor;
  for (const [row, line] of lines.entries()) {
    if (remaining <= line.length) {
      return { row, col: remaining };
    }
    remaining -= line.length + 1;
  }
  const lastRow = lines.length - 1;
  return { row: lastRow, col: lines[lastRow]?.length ?? 0 };
}

export function TextPrompt(props: TextPromptProps): ReactElement {
  const {
    value,
    width,
    maxRows,
    showHint,
    inputHistory,
    disabled,
    slashActive,
    slashPopupActive,
    autoApprove,
    onChange,
    onSubmit,
  } = props;
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const [, setCursorRevision] = useState(0);
  useEffect(() => {
    if (disabled) {
      return;
    }
    const refresh = (): void => {
      setCursorRevision((revision) => revision + 1);
    };
    stdout.on(CHAT_CURSOR_REFRESH_EVENT, refresh);
    return () => {
      stdout.off(CHAT_CURSOR_REFRESH_EVENT, refresh);
    };
  }, [disabled, stdout]);
  const editorWidth = Math.max(
    1,
    width - PROMPT_BORDER_WIDTH - PROMPT_HORIZONTAL_PADDING - PROMPT_PREFIX_WIDTH,
  );
  const [initialEditor] = useState(() => createLineBuffer(value));
  const editorRef = useRef<LineBufferState>(initialEditor);
  const historyIndexRef = useRef<number | undefined>(undefined);
  const historyDraftRef = useRef("");
  const [, setEditorRevision] = useState(0);
  useLayoutEffect(() => {
    if (editorRef.current.value !== value) {
      editorRef.current = createLineBuffer(value);
      historyIndexRef.current = undefined;
      historyDraftRef.current = "";
      setEditorRevision((revision) => revision + 1);
    }
  }, [value]);
  const commit = (next: LineBufferState): void => {
    const changed = editorRef.current.value !== next.value;
    editorRef.current = next;
    setEditorRevision((revision) => revision + 1);
    if (changed) {
      onChange(next.value);
    }
  };
  const leaveHistoryNavigation = (): void => {
    historyIndexRef.current = undefined;
    historyDraftRef.current = "";
  };
  const navigateHistory = (direction: -1 | 1): boolean => {
    const currentIndex = historyIndexRef.current;
    if (currentIndex === undefined) {
      if (direction === 1 || editorRef.current.value.length > 0 || inputHistory.length === 0) {
        return false;
      }
      const nextIndex = inputHistory.length - 1;
      const entry = inputHistory[nextIndex];
      if (entry === undefined) {
        return false;
      }
      historyDraftRef.current = editorRef.current.value;
      historyIndexRef.current = nextIndex;
      commit(createLineBuffer(entry));
      return true;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0) {
      return true;
    }
    if (nextIndex >= inputHistory.length) {
      const draft = historyDraftRef.current;
      leaveHistoryNavigation();
      commit(createLineBuffer(draft));
      return true;
    }
    const entry = inputHistory[nextIndex];
    if (entry === undefined) {
      leaveHistoryNavigation();
      return false;
    }
    historyIndexRef.current = nextIndex;
    commit(createLineBuffer(entry));
    return true;
  };

  useInput(
    (input, key) => {
      if (key.meta && (input === "." || input === ",")) {
        return;
      }
      if (isKeyboardProtocolResidue(input)) {
        return;
      }
      if (isMouseProtocolInput(input)) {
        return;
      }
      const newlineKey =
        input === "\n" || (key.ctrl && input === "j") || (key.return && (key.shift || key.meta));
      if (newlineKey) {
        leaveHistoryNavigation();
        commit(insertText(editorRef.current, "\n"));
        return;
      }
      const hasEnter = key.return || input.includes("\r");
      if (hasEnter) {
        leaveHistoryNavigation();
        const before = input.split("\r", 1)[0] ?? "";
        const submitted =
          before.length > 0 ? insertText(editorRef.current, before) : editorRef.current;
        if (slashActive || submitted.value.startsWith("/")) {
          props.onSlashRun(submitted.value);
          return;
        }
        onSubmit(submitted.value);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const historyActive = historyIndexRef.current !== undefined;
        const mayStartHistory = key.upArrow && editorRef.current.value.length === 0;
        if ((historyActive || mayStartHistory) && navigateHistory(key.upArrow ? -1 : 1)) {
          return;
        }
      }
      if (slashPopupActive) {
        if (key.upArrow) {
          props.onSlashMove(-1);
          return;
        }
        if (key.downArrow) {
          props.onSlashMove(1);
          return;
        }
        if (key.tab && !key.shift) {
          props.onSlashComplete();
          return;
        }
      }
      if (slashActive && key.escape) {
        leaveHistoryNavigation();
        commit(createLineBuffer(""));
        return;
      }
      if (key.ctrl && input === "v" && props.onRequestClipboardImage !== undefined) {
        props.onRequestClipboardImage();
        return;
      }
      const command = resolveEditorCommand(input, key);
      if (command !== undefined) {
        if (
          command === "delete-backward" &&
          editorRef.current.value.length === 0 &&
          (props.attachments?.length ?? 0) > 0
        ) {
          props.onRemoveLastAttachment?.();
          return;
        }
        leaveHistoryNavigation();
        const next =
          command === "move-up"
            ? moveVisualUp(editorRef.current, editorWidth)
            : command === "move-down"
              ? moveVisualDown(editorRef.current, editorWidth)
              : applyEditorCommand(command, editorRef.current);
        commit(next);
        return;
      }
      if (
        key.ctrl ||
        key.escape ||
        key.tab ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow
      ) {
        return;
      }
      if (input.length > 0) {
        leaveHistoryNavigation();
        commit(insertText(editorRef.current, input));
      }
    },
    { isActive: !disabled },
  );

  usePaste(
    (text) => {
      leaveHistoryNavigation();
      if (props.onPasteText?.(text) === true) {
        return;
      }
      commit(insertText(editorRef.current, text.replace(/\r\n?/g, "\n")));
    },
    { isActive: !disabled },
  );

  const editor = editorRef.current;
  const lines = editor.value.split("\n");
  const metrics = visualLineMetrics(editor, editorWidth);
  const attachments = props.attachments ?? [];
  const attachmentsPending = props.attachmentsPending === true;
  const attachmentRows = attachments.length > 0 || attachmentsPending ? 1 : 0;
  const availableBodyRows = Math.max(
    1,
    Math.floor(maxRows) - 2 - (showHint ? 1 : 0) - attachmentRows,
  );
  const visibleBodyRows = Math.min(metrics.totalRows, availableBodyRows);
  const firstVisibleRow = Math.min(
    Math.max(0, metrics.cursorRow - visibleBodyRows + 1),
    Math.max(0, metrics.totalRows - visibleBodyRows),
  );
  const visibleCursorRow = metrics.cursorRow - firstVisibleRow;
  const promptHeight = visibleBodyRows + 2 + (showHint ? 1 : 0) + attachmentRows;
  const promptTop = Math.max(0, props.viewportRows - (props.bottomOffset ?? 0) - promptHeight);
  // TextPrompt is the final child of the fixed root viewport. Anchoring from the viewport bottom
  // gives the cursor its post-layout row in the same render, while useBoxMetrics would report the
  // previous sibling layout for one commit when the slash popup mounts or unmounts. Ink's real
  // cursor is the terminal anchor used by IMEs to draw uncommitted preedit text.
  setCursorPosition(
    !disabled
      ? {
          x: PROMPT_CONTENT_LEFT + metrics.cursorColumn,
          y: promptTop + attachmentRows + 1 + visibleCursorRow,
        }
      : undefined,
  );
  const bodyContent = h(
    Box,
    {
      flexDirection: "column",
      flexShrink: 0,
      position: "relative",
      top: -firstVisibleRow,
      height: metrics.totalRows,
    },
    ...lines.map((line, index) => {
      const prefix = h(
        Box,
        { width: PROMPT_PREFIX_WIDTH, flexShrink: 0 },
        index === 0
          ? h(Text, disabled ? { dimColor: true } : { color: "green" }, "› ")
          : h(Text, null, "  "),
      );
      if (disabled) {
        return h(
          Box,
          { key: String(index) },
          prefix,
          h(Text, { dimColor: true, wrap: "hard" }, line),
        );
      }
      return h(Box, { key: String(index) }, prefix, h(Text, { wrap: "hard" }, line));
    }),
  );
  const body = h(
    Box,
    { flexDirection: "column", height: visibleBodyRows, overflowY: "hidden" },
    bodyContent,
  );
  const hintText = disabled
    ? (props.disabledHint ?? "Esc 中断本轮")
    : slashActive
      ? "↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 取消"
      : autoApprove
        ? "Shift+Tab 关闭 · Enter 发送 · 空输入 ↑ 历史 · Shift+Enter/Ctrl+J 换行 · / 命令"
        : "Enter 发送 · 空输入 ↑ 历史 · Shift+Enter/Ctrl+J 换行 · / 命令 · Shift+Tab 自动批准";
  // 自定义 disabled 提示是状态变更通知（如中断确认），用暗黄色让反馈落在视线焦点处
  const hintProps =
    disabled && props.disabledHint !== undefined
      ? { color: "yellow", dimColor: true }
      : { dimColor: true };
  const hint = showHint
    ? h(
        Box,
        { marginLeft: 1, flexShrink: 0, height: 1, overflowY: "hidden" },
        ...(autoApprove
          ? [
              h(Text, { color: "yellow", wrap: "truncate-end" }, `${GLYPHS.auto} auto`),
              h(Text, { ...hintProps, wrap: "truncate-end" }, ` · ${hintText}`),
            ]
          : [h(Text, { ...hintProps, wrap: "truncate-end" }, hintText)]),
      )
    : null;
  const attachmentRow =
    attachmentRows > 0
      ? h(
          Box,
          { marginLeft: 1, flexShrink: 0, height: 1, overflowY: "hidden" },
          attachments.length > 0
            ? h(
                Text,
                { color: "cyan", wrap: "truncate-end" },
                attachments
                  .map(
                    (attachment) => `${GLYPHS.attach} ${attachment.name} ${attachment.sizeLabel}`,
                  )
                  .join(" · "),
              )
            : null,
          attachmentsPending
            ? h(
                Text,
                { color: "yellow", wrap: "truncate-end" },
                attachments.length > 0 ? " · 读取剪贴板…" : "读取剪贴板…",
              )
            : null,
          attachments.length > 0
            ? h(Text, { dimColor: true, wrap: "truncate-end" }, " · 空输入退格移除")
            : null,
        )
      : null;
  return h(
    Box,
    { flexDirection: "column", width, flexShrink: 0 },
    attachmentRow,
    h(
      Box,
      {
        borderStyle: "round",
        borderColor: disabled ? "gray" : "cyan",
        paddingX: 2,
        height: visibleBodyRows + 2,
        overflowY: "hidden",
      },
      body,
    ),
    hint,
  );
}
