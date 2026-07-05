import { createElement as h, useRef } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput, useStdout } from "ink";

export interface TextPromptProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly slashActive: boolean;
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

export function TextPrompt(props: TextPromptProps): ReactElement {
  const { value, disabled, slashActive, autoApprove, onChange, onSubmit } = props;
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;
  const valueRef = useRef(value);
  valueRef.current = value;
  const commit = (next: string): void => {
    valueRef.current = next;
    onChange(next);
  };

  useInput(
    (input, key) => {
      if (key.meta && (input === "." || input === ",")) {
        return;
      }
      if (isKeyboardProtocolResidue(input)) {
        return;
      }
      if (key.backspace || key.delete) {
        commit(valueRef.current.slice(0, -1));
        return;
      }
      const newlineKey =
        input === "\n" || (key.ctrl && input === "j") || (key.return && (key.shift || key.meta));
      if (newlineKey) {
        commit(`${valueRef.current}\n`);
        return;
      }
      const hasEnter = key.return || input.includes("\r");
      if (hasEnter) {
        if (slashActive) {
          props.onSlashRun();
          return;
        }
        const before = input.split("\r", 1)[0] ?? "";
        onSubmit(valueRef.current + before);
        return;
      }
      if (slashActive) {
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
        if (key.escape) {
          commit("");
          return;
        }
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
        commit(valueRef.current + input);
      }
    },
    { isActive: !disabled },
  );

  const lines = value.split("\n");
  const body = h(
    Box,
    { flexDirection: "column" },
    ...lines.map((line, index) => {
      const isLast = index === lines.length - 1;
      const prefix = index === 0 ? h(Text, { color: "green" }, "› ") : h(Text, null, "  ");
      return h(
        Box,
        { key: String(index) },
        prefix,
        h(Text, disabled ? { dimColor: true } : {}, line),
        isLast && !disabled ? h(Text, null, "▏") : null,
      );
    }),
  );
  const hintText = slashActive
    ? "↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 取消"
    : autoApprove
      ? "Shift+Tab 关闭 · Enter 发送 · Shift+Enter/Ctrl+J 换行 · / 命令"
      : "Enter 发送 · Shift+Enter/Ctrl+J 换行 · / 命令 · Shift+Tab 自动批准";
  const hint = autoApprove
    ? h(
        Box,
        null,
        h(Text, { color: "yellow" }, "⏵⏵ auto"),
        h(Text, { dimColor: true }, ` · ${hintText}`),
      )
    : h(Text, { dimColor: true }, hintText);
  return h(
    Box,
    { flexDirection: "column", width },
    h(Box, { borderStyle: "round", borderColor: disabled ? "gray" : "cyan", paddingX: 1 }, body),
    hint,
  );
}
