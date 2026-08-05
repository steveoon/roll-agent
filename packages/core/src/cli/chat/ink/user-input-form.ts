import { createElement as h, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { TextPrompt } from "./text-prompt.ts";

type PendingUserInput = Extract<SessionEvent, { readonly type: "user-input-required" }>;
type UserInputResult = Parameters<AgentSession["resolveUserInput"]>[1];
type SubmittedUserInputResult = Extract<UserInputResult, { readonly status: "submitted" }>;
type SubmittedValue = SubmittedUserInputResult["values"][number];
type UserInputValue = SubmittedValue["value"];
type UserInputControl = PendingUserInput["form"]["controls"][number];
type ChoiceControl = Extract<UserInputControl, { readonly type: "choice" }>;

export interface UserInputFormProps {
  readonly request: PendingUserInput;
  readonly width: number;
  readonly viewportRows: number;
  readonly maxRows: number;
  readonly onResolve: (result: UserInputResult) => void;
}

function textValidationError(
  control: Extract<UserInputControl, { readonly type: "text" | "multiline" }>,
  value: string,
): string | undefined {
  if (control.type === "text" && value.includes("\n")) {
    return "此项只接受单行文本";
  }
  const minimum = Math.max(control.minLength ?? 0, control.required ? 1 : 0);
  const maximum = control.maxLength ?? 10_000;
  if (value.length < minimum) {
    return `至少输入 ${String(minimum)} 个字符`;
  }
  if (value.length > maximum) {
    return `最多输入 ${String(maximum)} 个字符`;
  }
  return undefined;
}

function numberValidationError(
  control: Extract<UserInputControl, { readonly type: "number" }>,
  value: number,
): string | undefined {
  if (!Number.isFinite(value)) {
    return "请输入有效数字";
  }
  if (control.integer === true && !Number.isInteger(value)) {
    return "请输入整数";
  }
  if (control.min !== undefined && value < control.min) {
    return `不能小于 ${String(control.min)}`;
  }
  if (control.max !== undefined && value > control.max) {
    return `不能大于 ${String(control.max)}`;
  }
  return undefined;
}

function choiceValidationError(
  control: ChoiceControl,
  selected: readonly string[],
): string | undefined {
  const minimum = Math.max(control.minSelections ?? 0, control.required ? 1 : 0);
  const maximum = control.maxSelections ?? (control.multiple ? control.options.length : 1);
  if (selected.length < minimum) {
    return `至少选择 ${String(minimum)} 项`;
  }
  if (selected.length > maximum) {
    return `最多选择 ${String(maximum)} 项`;
  }
  return undefined;
}

function controlHint(control: UserInputControl): string {
  if (control.type === "text") {
    return control.required ? "Enter 确认 · Esc 取消" : "Enter 确认（留空跳过）· Esc 取消";
  }
  if (control.type === "multiline") {
    return control.required
      ? "Enter 确认 · Shift+Enter/Ctrl+J 换行 · Esc 取消"
      : "Enter 确认（留空跳过）· Shift+Enter/Ctrl+J 换行 · Esc 取消";
  }
  if (control.type === "number") {
    return control.required ? "Enter 确认 · Esc 取消" : "Enter 确认（留空跳过）· Esc 取消";
  }
  if (control.type === "boolean") {
    return control.required
      ? "↑↓ 选择 · Enter 确认 · Esc 取消"
      : "↑↓ 选择 · Enter 确认 · S 跳过 · Esc 取消";
  }
  if (control.multiple) {
    return control.required || (control.minSelections ?? 0) > 0
      ? "↑↓ 移动 · Space 勾选 · Enter 确认 · Esc 取消"
      : "↑↓ 移动 · Space 勾选 · Enter 确认 · S 跳过 · Esc 取消";
  }
  return control.required || (control.minSelections ?? 0) > 0
    ? "↑↓ 选择 · Enter 确认 · Esc 取消"
    : "↑↓ 选择 · Enter 确认 · S 跳过 · Esc 取消";
}

function optionRows(
  control: ChoiceControl,
  cursor: number,
  selected: ReadonlySet<string>,
  maxRows: number,
): readonly ReactElement[] {
  const visibleCount = Math.max(1, maxRows);
  const first = Math.min(
    Math.max(0, cursor - visibleCount + 1),
    Math.max(0, control.options.length - visibleCount),
  );
  return control.options.slice(first, first + visibleCount).map((option, offset) => {
    const index = first + offset;
    const active = index === cursor;
    const mark = control.multiple ? (selected.has(option.id) ? "[x]" : "[ ]") : active ? "●" : "○";
    return h(
      Box,
      { key: option.id },
      h(
        Text,
        active ? { color: "cyan", bold: true } : null,
        `${active ? "›" : " "} ${mark} ${option.label}`,
      ),
      option.description === undefined
        ? null
        : h(Text, { dimColor: true, wrap: "truncate-end" }, ` — ${option.description}`),
    );
  });
}

export function UserInputForm(props: UserInputFormProps): ReactElement {
  const controls = props.request.form.controls;
  const [controlIndex, setControlIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [optionCursor, setOptionCursor] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [booleanValue, setBooleanValue] = useState(true);
  const valuesRef = useRef(new Map<string, UserInputValue>());
  const settledRef = useRef(false);
  const control = controls[controlIndex] ?? controls[0];

  const finish = (result: UserInputResult): void => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    props.onResolve(result);
  };

  const advance = (value: UserInputValue | undefined): void => {
    if (control === undefined) {
      finish({ status: "cancelled", reason: "用户输入表单无可用字段" });
      return;
    }
    if (value === undefined) {
      valuesRef.current.delete(control.id);
    } else {
      valuesRef.current.set(control.id, value);
    }
    if (controlIndex >= controls.length - 1) {
      const values = controls.flatMap((candidate) => {
        const candidateValue = valuesRef.current.get(candidate.id);
        return candidateValue === undefined ? [] : [{ id: candidate.id, value: candidateValue }];
      });
      finish({ status: "submitted", values });
      return;
    }
    setControlIndex((index) => index + 1);
    setDraft("");
    setError(undefined);
    setOptionCursor(0);
    setSelectedOptions(new Set<string>());
    setBooleanValue(true);
  };

  const submitDraft = (raw: string): void => {
    if (control === undefined) {
      return;
    }
    if (control.type === "text" || control.type === "multiline") {
      if (raw.length === 0 && !control.required) {
        advance(undefined);
        return;
      }
      const validationError = textValidationError(control, raw);
      if (validationError !== undefined) {
        setError(validationError);
        return;
      }
      advance(raw);
      return;
    }
    if (control.type === "number") {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        if (control.required) {
          setError("请输入数字");
        } else {
          advance(undefined);
        }
        return;
      }
      const value = Number(trimmed);
      const validationError = numberValidationError(control, value);
      if (validationError !== undefined) {
        setError(validationError);
        return;
      }
      advance(value);
    }
  };

  useInput((input, key) => {
    if (key.escape && !key.meta) {
      finish({ status: "cancelled", reason: "用户取消" });
      return;
    }
    if (key.tab && key.shift) {
      return;
    }
    if (
      control === undefined ||
      control.type === "text" ||
      control.type === "multiline" ||
      control.type === "number"
    ) {
      return;
    }
    if (!control.required && input.toLowerCase() === "s") {
      if (control.type !== "choice" || (control.minSelections ?? 0) === 0) {
        advance(undefined);
      }
      return;
    }
    if (control.type === "boolean") {
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        setBooleanValue((value) => !value);
        return;
      }
      if (input.toLowerCase() === "y" || input === "1") {
        setBooleanValue(true);
        return;
      }
      if (input.toLowerCase() === "n" || input === "0") {
        setBooleanValue(false);
        return;
      }
      if (key.return || input.includes("\r")) {
        advance(booleanValue);
      }
      return;
    }
    if (key.upArrow) {
      setOptionCursor((index) => (index <= 0 ? control.options.length - 1 : index - 1));
      return;
    }
    if (key.downArrow) {
      setOptionCursor((index) => (index >= control.options.length - 1 ? 0 : index + 1));
      return;
    }
    const option = control.options[optionCursor];
    if (option === undefined) {
      return;
    }
    if (control.multiple && input === " ") {
      setSelectedOptions((current) => {
        const next = new Set(current);
        if (next.has(option.id)) {
          next.delete(option.id);
        } else {
          next.add(option.id);
        }
        return next;
      });
      setError(undefined);
      return;
    }
    if (key.return || input.includes("\r")) {
      const selected = control.multiple ? [...selectedOptions] : [option.id];
      const validationError = choiceValidationError(control, selected);
      if (validationError !== undefined) {
        setError(validationError);
        return;
      }
      advance(control.multiple ? selected : option.id);
    }
  });

  if (control === undefined) {
    return h(Text, { color: "red" }, "用户输入表单无可用字段");
  }

  const title = props.request.form.title ?? "需要你的输入";
  const headingRows =
    4 +
    (props.request.form.description === undefined ? 0 : 1) +
    (control.description === undefined ? 0 : 1);
  const choiceRows = Math.max(1, props.maxRows - headingRows - 2);
  const editorRows = Math.max(3, Math.min(6, props.maxRows - headingRows));
  const field =
    control.type === "text" || control.type === "multiline" || control.type === "number"
      ? h(TextPrompt, {
          key: control.id,
          value: draft,
          width: props.width,
          viewportRows: props.viewportRows,
          maxRows: editorRows,
          showHint: false,
          inputHistory: [],
          disabled: false,
          slashActive: false,
          slashPopupActive: false,
          autoApprove: false,
          onChange: (value: string) => {
            setDraft(value);
            setError(undefined);
          },
          onSubmit: submitDraft,
          onSlashMove: () => undefined,
          onSlashComplete: () => undefined,
          onSlashRun: submitDraft,
        })
      : control.type === "boolean"
        ? h(
            Box,
            { gap: 2 },
            h(
              Text,
              booleanValue ? { color: "cyan", bold: true } : null,
              `${booleanValue ? "›" : " "} 是`,
            ),
            h(
              Text,
              !booleanValue ? { color: "cyan", bold: true } : null,
              `${!booleanValue ? "›" : " "} 否`,
            ),
          )
        : h(
            Box,
            { flexDirection: "column" },
            ...optionRows(control, optionCursor, selectedOptions, choiceRows),
          );

  return h(
    Box,
    { flexDirection: "column", width: props.width, flexShrink: 0 },
    h(
      Box,
      { paddingX: 1, justifyContent: "space-between" },
      h(Text, { bold: true, color: "cyan", wrap: "truncate-end" }, title),
      h(Text, { dimColor: true }, `${String(controlIndex + 1)}/${String(controls.length)}`),
    ),
    props.request.form.description === undefined
      ? null
      : h(Text, { dimColor: true, wrap: "truncate-end" }, props.request.form.description),
    h(
      Text,
      { bold: true, wrap: "truncate-end" },
      `${control.label}${control.required ? " *" : ""}`,
    ),
    control.description === undefined
      ? null
      : h(Text, { dimColor: true, wrap: "truncate-end" }, control.description),
    field,
    error === undefined ? null : h(Text, { color: "red", wrap: "truncate-end" }, error),
    h(Text, { dimColor: true, wrap: "truncate-end" }, controlHint(control)),
  );
}
