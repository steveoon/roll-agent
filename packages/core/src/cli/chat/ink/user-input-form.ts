import { createElement as h, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { displayWidth } from "./display-width.ts";
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

const SUMMARY_LABEL_MAX_WIDTH = 24;

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

function controlHint(control: UserInputControl, escLabel: string): string {
  if (control.type === "text") {
    return control.required ? `Enter 确认 · ${escLabel}` : `Enter 确认（留空跳过）· ${escLabel}`;
  }
  if (control.type === "multiline") {
    return control.required
      ? `Enter 确认 · Shift+Enter/Ctrl+J 换行 · ${escLabel}`
      : `Enter 确认（留空跳过）· Shift+Enter/Ctrl+J 换行 · ${escLabel}`;
  }
  if (control.type === "number") {
    return control.required ? `Enter 确认 · ${escLabel}` : `Enter 确认（留空跳过）· ${escLabel}`;
  }
  if (control.type === "boolean") {
    return control.required
      ? `↑↓ 选择 · Enter 确认 · ${escLabel}`
      : `↑↓ 选择 · Enter 确认 · S 跳过 · ${escLabel}`;
  }
  if (control.multiple) {
    return control.required || (control.minSelections ?? 0) > 0
      ? `↑↓ 移动 · Space 勾选 · Enter 确认 · ${escLabel}`
      : `↑↓ 移动 · Space 勾选 · Enter 确认 · S 跳过 · ${escLabel}`;
  }
  return control.required || (control.minSelections ?? 0) > 0
    ? `↑↓ 选择 · Enter 确认 · ${escLabel}`
    : `↑↓ 选择 · Enter 确认 · S 跳过 · ${escLabel}`;
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

function summaryValueText(
  control: UserInputControl,
  stored: UserInputValue | undefined,
): { readonly text: string; readonly dim: boolean } {
  if (stored === undefined) {
    return { text: "（未填）", dim: true };
  }
  if (control.type === "boolean") {
    return { text: stored === true ? "是" : "否", dim: false };
  }
  if (control.type === "choice") {
    const ids = Array.isArray(stored) ? stored : [String(stored)];
    const labels = ids.map((id) => control.options.find((option) => option.id === id)?.label ?? id);
    if (labels.length === 0) {
      return { text: "（未选）", dim: true };
    }
    return { text: labels.join("、"), dim: false };
  }
  const raw = String(stored);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return { text: raw.includes("\n") ? `${firstLine} …` : firstLine, dim: false };
}

function padToWidth(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

export function UserInputForm(props: UserInputFormProps): ReactElement {
  const controls = props.request.form.controls;
  const [view, setView] = useState<"control" | "summary">("control");
  const [returnToSummary, setReturnToSummary] = useState(false);
  const [summaryCursor, setSummaryCursor] = useState(0);
  const [controlIndex, setControlIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [optionCursor, setOptionCursor] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [booleanValue, setBooleanValue] = useState(false);
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

  const enterControl = (index: number, editFromSummary: boolean): void => {
    const target = controls[index];
    if (target === undefined) {
      return;
    }
    const stored = valuesRef.current.get(target.id);
    setView("control");
    setReturnToSummary(editFromSummary);
    setControlIndex(index);
    setError(undefined);
    if (target.type === "text" || target.type === "multiline") {
      setDraft(typeof stored === "string" ? stored : "");
      return;
    }
    if (target.type === "number") {
      setDraft(typeof stored === "number" ? String(stored) : "");
      return;
    }
    if (target.type === "boolean") {
      setBooleanValue(stored === true);
      return;
    }
    const selectedIds = Array.isArray(stored) ? stored : typeof stored === "string" ? [stored] : [];
    setSelectedOptions(new Set(selectedIds));
    const cursor = target.multiple ? 0 : target.options.findIndex((option) => option.id === stored);
    setOptionCursor(cursor >= 0 ? cursor : 0);
  };

  const enterSummary = (cursor: number): void => {
    setView("summary");
    setReturnToSummary(false);
    setSummaryCursor(cursor);
    setError(undefined);
  };

  const buildSubmission = (): UserInputResult => ({
    status: "submitted",
    values: controls.flatMap((candidate) => {
      const candidateValue = valuesRef.current.get(candidate.id);
      return candidateValue === undefined ? [] : [{ id: candidate.id, value: candidateValue }];
    }),
  });

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
    if (returnToSummary || controlIndex >= controls.length - 1) {
      enterSummary(controls.length);
      return;
    }
    enterControl(controlIndex + 1, false);
  };

  const goBack = (): void => {
    if (view === "summary") {
      enterControl(controls.length - 1, false);
      return;
    }
    if (returnToSummary) {
      setView("summary");
      setReturnToSummary(false);
      setError(undefined);
      return;
    }
    if (controlIndex <= 0) {
      finish({ status: "cancelled", reason: "用户取消" });
      return;
    }
    enterControl(controlIndex - 1, false);
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
      goBack();
      return;
    }
    if (key.tab && key.shift) {
      return;
    }
    if (view === "summary") {
      const rowCount = controls.length + 1;
      if (key.upArrow) {
        setSummaryCursor((cursor) => (cursor <= 0 ? rowCount - 1 : cursor - 1));
        return;
      }
      if (key.downArrow) {
        setSummaryCursor((cursor) => (cursor >= rowCount - 1 ? 0 : cursor + 1));
        return;
      }
      if (key.return || input.includes("\r")) {
        if (summaryCursor >= controls.length) {
          finish(buildSubmission());
        } else {
          enterControl(summaryCursor, true);
        }
      }
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

  if (view === "summary") {
    const rowCount = controls.length + 1;
    const chromeRows = 2;
    const spacious = props.maxRows >= chromeRows + 2 + Math.min(rowCount, 4);
    const gapRows = spacious ? 1 : 0;
    const topMargin = spacious ? 1 : 0;
    const bodyBudget = Math.max(1, props.maxRows - chromeRows - gapRows - topMargin);
    const first = Math.min(
      Math.max(0, summaryCursor - bodyBudget + 1),
      Math.max(0, rowCount - bodyBudget),
    );
    const labelWidth = Math.min(
      SUMMARY_LABEL_MAX_WIDTH,
      controls.reduce((width, candidate) => Math.max(width, displayWidth(candidate.label)), 0),
    );
    const rows: ReactElement[] = [];
    for (let index = first; index < Math.min(first + bodyBudget, rowCount); index += 1) {
      const active = index === summaryCursor;
      if (index >= controls.length) {
        rows.push(
          h(
            Box,
            { key: "__submit", marginTop: spacious && rowCount <= bodyBudget ? 1 : 0 },
            h(Text, active ? { color: "green", bold: true } : null, `${active ? "›" : " "} 提交`),
          ),
        );
        continue;
      }
      const candidate = controls[index];
      if (candidate === undefined) {
        continue;
      }
      const value = summaryValueText(candidate, valuesRef.current.get(candidate.id));
      rows.push(
        h(
          Box,
          { key: candidate.id },
          h(
            Text,
            active ? { color: "cyan", bold: true } : null,
            `${active ? "›" : " "} ${padToWidth(candidate.label, labelWidth)}`,
          ),
          h(
            Text,
            {
              ...(active ? { color: "cyan" } : value.dim ? { dimColor: true } : {}),
              wrap: "truncate-end",
            },
            `  ${value.text}`,
          ),
        ),
      );
    }
    return h(
      Box,
      { flexDirection: "column", width: props.width, flexShrink: 0, marginTop: topMargin },
      h(
        Box,
        { paddingX: 1, justifyContent: "space-between" },
        h(Text, { bold: true, color: "cyan", wrap: "truncate-end" }, title),
        h(Text, { dimColor: true }, " 确认提交"),
      ),
      h(Box, { paddingX: 1, marginTop: gapRows, flexDirection: "column" }, ...rows),
      h(
        Box,
        { paddingX: 1 },
        h(Text, { dimColor: true, wrap: "truncate-end" }, "↑↓ 选择 · Enter 确认 · Esc 返回"),
      ),
    );
  }

  const escLabel = controlIndex === 0 && !returnToSummary ? "Esc 取消" : "Esc 返回";
  const formDescription = props.request.form.description;
  const headerRows = 1 + (formDescription === undefined ? 0 : 1);
  const labelRows = 1 + (control.description === undefined ? 0 : 1);
  const chromeRows = headerRows + labelRows + 1 + (error === undefined ? 0 : 1);
  const spacious = props.maxRows >= chromeRows + 2 + 3;
  const gapRows = spacious ? 1 : 0;
  const topMargin = spacious ? 1 : 0;
  const bodyBudget = Math.max(1, props.maxRows - chromeRows - gapRows - topMargin);
  const choiceRows = bodyBudget;
  const editorRows = Math.max(3, Math.min(6, bodyBudget));
  const errorRow =
    error === undefined
      ? null
      : h(Box, { paddingX: 1 }, h(Text, { color: "red", wrap: "truncate-end" }, error));
  const field =
    control.type === "text" || control.type === "multiline" || control.type === "number"
      ? h(TextPrompt, {
          key: control.id,
          value: draft,
          width: props.width,
          viewportRows: props.viewportRows,
          maxRows: editorRows,
          bottomOffset: 1 + (error === undefined ? 0 : 1),
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
            { paddingX: 1, gap: 2 },
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
            { paddingX: 1, flexDirection: "column" },
            ...optionRows(control, optionCursor, selectedOptions, choiceRows),
          );

  return h(
    Box,
    { flexDirection: "column", width: props.width, flexShrink: 0, marginTop: topMargin },
    h(
      Box,
      { paddingX: 1, justifyContent: "space-between" },
      h(Text, { bold: true, color: "cyan", wrap: "truncate-end" }, title),
      h(Text, { dimColor: true }, ` ${String(controlIndex + 1)}/${String(controls.length)}`),
    ),
    formDescription === undefined
      ? null
      : h(Box, { paddingX: 1 }, h(Text, { dimColor: true, wrap: "truncate-end" }, formDescription)),
    h(
      Box,
      { paddingX: 1, marginTop: gapRows },
      h(Text, { bold: true, wrap: "truncate-end" }, control.label),
      control.required ? h(Text, { color: "yellow" }, " *") : null,
    ),
    control.description === undefined
      ? null
      : h(
          Box,
          { paddingX: 1 },
          h(Text, { dimColor: true, wrap: "truncate-end" }, control.description),
        ),
    field,
    errorRow,
    h(
      Box,
      { paddingX: 1 },
      h(Text, { dimColor: true, wrap: "truncate-end" }, controlHint(control, escLabel)),
    ),
  );
}
