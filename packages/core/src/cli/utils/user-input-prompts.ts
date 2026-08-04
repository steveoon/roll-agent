import {
  confirm as clackBoolean,
  isCancel,
  multiline as clackMultiline,
  multiselect as clackMultiselect,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import type { Readable, Writable } from "node:stream";

// Runtime Protocol 1.2 defines this absolute bound even when a control omits maxLength.
const USER_INPUT_TEXT_ABSOLUTE_MAX_CHARS = 10_000;

type UserInputRequiredEvent = Extract<SessionEvent, { readonly type: "user-input-required" }>;

export type ChatUserInputForm = UserInputRequiredEvent["form"];
export type ChatUserInputResult = Parameters<AgentSession["resolveUserInput"]>[1];
export type ChatUserInputControl = ChatUserInputForm["controls"][number];

type ChatUserInputControlType = ChatUserInputControl["type"];
type ChatUserInputSubmittedResult = Extract<ChatUserInputResult, { readonly status: "submitted" }>;
type ChatUserInputSubmittedValue = ChatUserInputSubmittedResult["values"][number];

export type UserInputPromptAnswer<TValue> =
  | { readonly status: "answered"; readonly value: TValue }
  | { readonly status: "cancelled" };

export interface UserInputTextPromptOptions {
  readonly message: string;
  readonly signal?: AbortSignal;
  readonly validate: (value: string | undefined) => string | undefined;
}

export interface UserInputBooleanPromptOptions {
  readonly message: string;
  readonly signal?: AbortSignal;
}

export interface UserInputChoicePromptOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface UserInputSelectPromptOptions {
  readonly message: string;
  readonly options: readonly UserInputChoicePromptOption[];
  readonly optional: boolean;
  readonly signal?: AbortSignal;
}

export interface UserInputMultiselectPromptOptions {
  readonly message: string;
  readonly options: readonly UserInputChoicePromptOption[];
  readonly signal?: AbortSignal;
}

export interface UserInputPromptDriver {
  text(options: UserInputTextPromptOptions): Promise<UserInputPromptAnswer<string>>;
  multiline(options: UserInputTextPromptOptions): Promise<UserInputPromptAnswer<string>>;
  confirm(options: UserInputBooleanPromptOptions): Promise<UserInputPromptAnswer<boolean>>;
  select(options: UserInputSelectPromptOptions): Promise<UserInputPromptAnswer<string | undefined>>;
  multiselect(
    options: UserInputMultiselectPromptOptions,
  ): Promise<UserInputPromptAnswer<readonly string[]>>;
}

export interface ChatUserInputPrompt {
  request(form: ChatUserInputForm, signal?: AbortSignal): Promise<ChatUserInputResult>;
}

export interface ClackUserInputPromptOptions {
  readonly input?: Readable;
  readonly output?: Writable;
}

interface UserInputPromptContext {
  readonly driver: UserInputPromptDriver;
  readonly form: ChatUserInputForm;
  readonly index: number;
  readonly signal?: AbortSignal;
}

type PromptedControl =
  | { readonly status: "value"; readonly value: ChatUserInputSubmittedValue }
  | { readonly status: "omitted" }
  | { readonly status: "cancelled" };

type UserInputControlPrompter = (
  control: ChatUserInputControl,
  context: UserInputPromptContext,
) => Promise<PromptedControl>;

type ParsedNumberInput =
  | { readonly status: "value"; readonly value: number }
  | { readonly status: "omitted" }
  | { readonly status: "invalid"; readonly message: string };

function answered<TValue>(value: TValue): UserInputPromptAnswer<TValue> {
  return { status: "answered", value };
}

function cancelledAnswer<TValue>(): UserInputPromptAnswer<TValue> {
  return { status: "cancelled" };
}

function commonClackOptions(
  options: ClackUserInputPromptOptions,
  signal: AbortSignal | undefined,
): {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
} {
  return {
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

function createClackPromptDriver(clackOptions: ClackUserInputPromptOptions): UserInputPromptDriver {
  return {
    async text(options) {
      const answer = await clackText({
        message: options.message,
        validate: options.validate,
        ...commonClackOptions(clackOptions, options.signal),
      });
      return isCancel(answer) ? cancelledAnswer() : answered(answer);
    },
    async multiline(options) {
      const answer = await clackMultiline({
        message: options.message,
        validate: options.validate,
        showSubmit: true,
        ...commonClackOptions(clackOptions, options.signal),
      });
      return isCancel(answer) ? cancelledAnswer() : answered(answer);
    },
    async confirm(options) {
      const answer = await clackBoolean({
        message: options.message,
        initialValue: false,
        ...commonClackOptions(clackOptions, options.signal),
      });
      return isCancel(answer) ? cancelledAnswer() : answered(answer);
    },
    async select(options) {
      interface ClackChoiceValue {
        readonly selectedId: string | null;
      }
      const choices: Array<{
        readonly value: ClackChoiceValue;
        readonly label: string;
        readonly hint?: string;
      }> = options.options.map((option) => ({
        value: { selectedId: option.value },
        label: option.label,
        ...(option.hint !== undefined ? { hint: option.hint } : {}),
      }));
      if (options.optional) {
        choices.unshift({ value: { selectedId: null }, label: "跳过" });
      }
      const answer = await clackSelect<ClackChoiceValue>({
        message: options.message,
        options: choices,
        ...commonClackOptions(clackOptions, options.signal),
      });
      if (isCancel(answer)) {
        return cancelledAnswer();
      }
      return answered(answer.selectedId ?? undefined);
    },
    async multiselect(options) {
      const answer = await clackMultiselect<string>({
        message: options.message,
        options: options.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.hint !== undefined ? { hint: option.hint } : {}),
        })),
        required: false,
        ...commonClackOptions(clackOptions, options.signal),
      });
      return isCancel(answer) ? cancelledAnswer() : answered(answer);
    },
  };
}

function isControlType<TType extends ChatUserInputControlType>(
  control: ChatUserInputControl,
  type: TType,
): control is Extract<ChatUserInputControl, { readonly type: TType }> {
  return control.type === type;
}

function requireControlType<TType extends ChatUserInputControlType>(
  control: ChatUserInputControl,
  type: TType,
): Extract<ChatUserInputControl, { readonly type: TType }> {
  if (!isControlType(control, type)) {
    throw new Error(`Expected user input control ${type}, received ${control.type}`);
  }
  return control;
}

function promptMessage(
  context: UserInputPromptContext,
  control: ChatUserInputControl,
  validationError?: string,
): string {
  const formHeading =
    context.index === 0
      ? [context.form.title, context.form.description].filter(
          (value): value is string => value !== undefined,
        )
      : [];
  return [
    ...formHeading,
    control.label,
    control.description,
    validationError === undefined ? undefined : `请重试：${validationError}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
}

function textValidationError(
  control: Extract<ChatUserInputControl, { readonly type: "text" | "multiline" }>,
  value: string | undefined,
): string | undefined {
  const length = value?.length ?? 0;
  if (!control.required && length === 0) {
    return undefined;
  }
  const minimum = Math.max(control.minLength ?? 0, control.required ? 1 : 0);
  const maximum = control.maxLength ?? USER_INPUT_TEXT_ABSOLUTE_MAX_CHARS;
  if (length < minimum) {
    return `至少输入 ${String(minimum)} 个字符`;
  }
  if (length > maximum) {
    return `最多输入 ${String(maximum)} 个字符`;
  }
  return undefined;
}

function parseNumberInput(
  control: Extract<ChatUserInputControl, { readonly type: "number" }>,
  input: string | undefined,
): ParsedNumberInput {
  const normalized = input?.trim() ?? "";
  if (normalized.length === 0) {
    return control.required ? { status: "invalid", message: "请输入数字" } : { status: "omitted" };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { status: "invalid", message: "请输入有效数字" };
  }
  if (control.integer === true && !Number.isInteger(value)) {
    return { status: "invalid", message: "请输入整数" };
  }
  if (control.min !== undefined && value < control.min) {
    return { status: "invalid", message: `数字不能小于 ${String(control.min)}` };
  }
  if (control.max !== undefined && value > control.max) {
    return { status: "invalid", message: `数字不能大于 ${String(control.max)}` };
  }
  return { status: "value", value };
}

function choiceOptions(
  control: Extract<ChatUserInputControl, { readonly type: "choice" }>,
): readonly UserInputChoicePromptOption[] {
  return control.options.map((option) => ({
    value: option.id,
    label: option.label,
    ...(option.description !== undefined ? { hint: option.description } : {}),
  }));
}

async function promptTextControl(
  candidate: ChatUserInputControl,
  context: UserInputPromptContext,
): Promise<PromptedControl> {
  const control = requireControlType(candidate, "text");
  let validationError: string | undefined;
  while (true) {
    const answer = await context.driver.text({
      message: promptMessage(context, control, validationError),
      validate: (value) => textValidationError(control, value),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    if (answer.status === "cancelled") {
      return answer;
    }
    if (!control.required && answer.value.length === 0) {
      return { status: "omitted" };
    }
    validationError = textValidationError(control, answer.value);
    if (validationError === undefined) {
      return { status: "value", value: { id: control.id, value: answer.value } };
    }
  }
}

async function promptMultilineControl(
  candidate: ChatUserInputControl,
  context: UserInputPromptContext,
): Promise<PromptedControl> {
  const control = requireControlType(candidate, "multiline");
  let validationError: string | undefined;
  while (true) {
    const answer = await context.driver.multiline({
      message: promptMessage(context, control, validationError),
      validate: (value) => textValidationError(control, value),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    if (answer.status === "cancelled") {
      return answer;
    }
    if (!control.required && answer.value.length === 0) {
      return { status: "omitted" };
    }
    validationError = textValidationError(control, answer.value);
    if (validationError === undefined) {
      return { status: "value", value: { id: control.id, value: answer.value } };
    }
  }
}

async function promptNumberControl(
  candidate: ChatUserInputControl,
  context: UserInputPromptContext,
): Promise<PromptedControl> {
  const control = requireControlType(candidate, "number");
  let validationError: string | undefined;
  while (true) {
    const answer = await context.driver.text({
      message: promptMessage(context, control, validationError),
      validate: (value) => {
        const parsed = parseNumberInput(control, value);
        return parsed.status === "invalid" ? parsed.message : undefined;
      },
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    if (answer.status === "cancelled") {
      return answer;
    }
    const parsed = parseNumberInput(control, answer.value);
    if (parsed.status === "invalid") {
      validationError = parsed.message;
      continue;
    }
    return parsed.status === "omitted"
      ? parsed
      : { status: "value", value: { id: control.id, value: parsed.value } };
  }
}

async function promptBooleanControl(
  candidate: ChatUserInputControl,
  context: UserInputPromptContext,
): Promise<PromptedControl> {
  const control = requireControlType(candidate, "boolean");
  const answer = await context.driver.confirm({
    message: promptMessage(context, control),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  return answer.status === "cancelled"
    ? answer
    : { status: "value", value: { id: control.id, value: answer.value } };
}

async function promptChoiceControl(
  candidate: ChatUserInputControl,
  context: UserInputPromptContext,
): Promise<PromptedControl> {
  const control = requireControlType(candidate, "choice");
  const options = choiceOptions(control);
  const optionIds = new Set(options.map((option) => option.value));
  const minimum = Math.max(control.minSelections ?? 0, control.required ? 1 : 0);
  const maximum = control.maxSelections ?? (control.multiple ? control.options.length : 1);
  let validationError: string | undefined;
  if (!control.multiple) {
    while (true) {
      const answer = await context.driver.select({
        message: promptMessage(context, control, validationError),
        options,
        optional: minimum === 0,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      if (answer.status === "cancelled") {
        return answer;
      }
      if (answer.value === undefined) {
        if (minimum === 0) {
          return { status: "omitted" };
        }
        validationError = "请选择一个选项";
        continue;
      }
      if (!optionIds.has(answer.value)) {
        validationError = "选择了未知选项";
        continue;
      }
      return { status: "value", value: { id: control.id, value: answer.value } };
    }
  }
  while (true) {
    const answer = await context.driver.multiselect({
      message: promptMessage(context, control, validationError),
      options,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    if (answer.status === "cancelled") {
      return answer;
    }
    const selected = new Set(answer.value);
    if (selected.size !== answer.value.length) {
      validationError = "不能重复选择同一选项";
      continue;
    }
    if (answer.value.some((optionId) => !optionIds.has(optionId))) {
      validationError = "选择了未知选项";
      continue;
    }
    if (answer.value.length < minimum) {
      validationError = `至少选择 ${String(minimum)} 项`;
      continue;
    }
    if (answer.value.length > maximum) {
      validationError = `最多选择 ${String(maximum)} 项`;
      continue;
    }
    return { status: "value", value: { id: control.id, value: [...answer.value] } };
  }
}

const USER_INPUT_CONTROL_PROMPTERS = {
  text: promptTextControl,
  multiline: promptMultilineControl,
  number: promptNumberControl,
  boolean: promptBooleanControl,
  choice: promptChoiceControl,
} as const satisfies Readonly<Record<ChatUserInputControlType, UserInputControlPrompter>>;

function cancelledResult(signal: AbortSignal | undefined): ChatUserInputResult {
  return {
    status: "cancelled",
    reason: signal?.aborted === true ? "会话正在关闭" : "用户取消",
  };
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createUserInputPromptAdapter(driver: UserInputPromptDriver): ChatUserInputPrompt {
  return {
    async request(form, signal) {
      if (signalIsAborted(signal)) {
        return cancelledResult(signal);
      }
      const values: ChatUserInputSubmittedValue[] = [];
      try {
        for (const [index, control] of form.controls.entries()) {
          if (signalIsAborted(signal)) {
            return cancelledResult(signal);
          }
          const prompted = await USER_INPUT_CONTROL_PROMPTERS[control.type](control, {
            driver,
            form,
            index,
            ...(signal !== undefined ? { signal } : {}),
          });
          if (prompted.status === "cancelled") {
            return cancelledResult(signal);
          }
          if (prompted.status === "value") {
            values.push(prompted.value);
          }
        }
      } catch (error) {
        if (signalIsAborted(signal)) {
          return cancelledResult(signal);
        }
        throw error;
      }
      return { status: "submitted", values };
    },
  };
}

export function createClackUserInputPrompt(
  options: ClackUserInputPromptOptions = {},
): ChatUserInputPrompt {
  return createUserInputPromptAdapter(createClackPromptDriver(options));
}
