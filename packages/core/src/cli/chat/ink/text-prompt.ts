import { createElement as h, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { GLYPHS } from "../../utils/glyphs.ts";
import { applyEditorCommand, resolveEditorCommand } from "./editor-keymap.ts";
import { createLineBuffer, graphemeAt, insertText } from "./line-buffer.ts";
import type { LineBufferState } from "./line-buffer.ts";

export interface TextPromptProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly slashActive: boolean;
  readonly slashPopupActive: boolean;
  readonly autoApprove: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly onSlashMove: (direction: 1 | -1) => void;
  readonly onSlashComplete: () => void;
  readonly onSlashRun: () => void;
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
  const { value, disabled, slashActive, slashPopupActive, autoApprove, onChange, onSubmit } = props;
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const [initialEditor] = useState(() => createLineBuffer(value));
  const editorRef = useRef<LineBufferState>(initialEditor);
  const [, setEditorRevision] = useState(0);
  useLayoutEffect(() => {
    if (editorRef.current.value !== value) {
      editorRef.current = createLineBuffer(value);
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

  useInput(
    (input, key) => {
      if (key.meta && (input === "." || input === ",")) {
        return;
      }
      if (isKeyboardProtocolResidue(input)) {
        return;
      }
      const newlineKey =
        input === "\n" || (key.ctrl && input === "j") || (key.return && (key.shift || key.meta));
      if (newlineKey) {
        commit(insertText(editorRef.current, "\n"));
        return;
      }
      const hasEnter = key.return || input.includes("\r");
      if (hasEnter) {
        if (slashActive) {
          props.onSlashRun();
          return;
        }
        const before = input.split("\r", 1)[0] ?? "";
        const submitted =
          before.length > 0 ? insertText(editorRef.current, before) : editorRef.current;
        onSubmit(submitted.value);
        return;
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
        commit(createLineBuffer(""));
        return;
      }
      const command = resolveEditorCommand(input, key);
      if (command !== undefined) {
        commit(applyEditorCommand(command, editorRef.current));
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
        commit(insertText(editorRef.current, input));
      }
    },
    { isActive: !disabled },
  );

  usePaste(
    (text) => {
      commit(insertText(editorRef.current, text.replace(/\r\n?/g, "\n")));
    },
    { isActive: !disabled },
  );

  const editor = editorRef.current;
  const lines = editor.value.split("\n");
  const cursorPosition = cursorPositionOf(lines, editor.cursor);
  const body = h(
    Box,
    { flexDirection: "column" },
    ...lines.map((line, index) => {
      const prefix = index === 0 ? h(Text, { color: "green" }, "› ") : h(Text, null, "  ");
      if (disabled) {
        return h(Box, { key: String(index) }, prefix, h(Text, { dimColor: true }, line));
      }
      if (index !== cursorPosition.row) {
        return h(Box, { key: String(index) }, prefix, h(Text, null, line));
      }
      const cluster = graphemeAt(line, cursorPosition.col);
      const before = line.slice(0, cursorPosition.col);
      const after = line.slice(cursorPosition.col + cluster.length);
      return h(
        Box,
        { key: String(index) },
        prefix,
        before.length > 0 ? h(Text, null, before) : null,
        h(Text, { inverse: true }, cluster === "" ? " " : cluster),
        after.length > 0 ? h(Text, null, after) : null,
      );
    }),
  );
  const hintText = disabled
    ? "Esc 中断本轮"
    : slashActive
      ? "↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 取消"
      : autoApprove
        ? "Shift+Tab 关闭 · Enter 发送 · Shift+Enter/Ctrl+J 换行 · / 命令"
        : "Enter 发送 · Shift+Enter/Ctrl+J 换行 · / 命令 · Shift+Tab 自动批准";
  const hint = h(
    Box,
    { marginLeft: 1 },
    ...(autoApprove
      ? [
          h(Text, { color: "yellow" }, `${GLYPHS.auto} auto`),
          h(Text, { dimColor: true }, ` · ${hintText}`),
        ]
      : [h(Text, { dimColor: true }, hintText)]),
  );
  return h(
    Box,
    { flexDirection: "column", width },
    h(Box, { borderStyle: "round", borderColor: disabled ? "yellow" : "cyan", paddingX: 2 }, body),
    hint,
  );
}
