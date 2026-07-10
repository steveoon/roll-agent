import {
  cancel,
  confirm,
  intro,
  isCancel,
  log as clackLog,
  multiselect,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";

const PROMPT_OUTPUT = process.stderr;

export class ConfigSetupCancelledError extends Error {
  constructor() {
    super("配置向导已取消");
  }
}

export interface PromptOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly hint?: string;
}

export interface ConfigPromptAdapter {
  intro(title: string): void;
  outro(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  select<Value extends string>(options: {
    readonly message: string;
    readonly options: readonly PromptOption<Value>[];
    readonly initialValue?: Value;
  }): Promise<Value>;
  text(options: {
    readonly message: string;
    readonly placeholder?: string;
    readonly defaultValue?: string;
    readonly initialValue?: string;
    readonly required?: boolean;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string>;
  password(options: {
    readonly message: string;
    readonly required?: boolean;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string>;
  confirm(options: { readonly message: string; readonly initialValue?: boolean }): Promise<boolean>;
  multiselect<Value extends string>(options: {
    readonly message: string;
    readonly options: readonly PromptOption<Value>[];
    readonly initialValues?: readonly Value[];
    readonly required?: boolean;
  }): Promise<readonly Value[]>;
}

export const clackPromptAdapter: ConfigPromptAdapter = {
  intro(title) {
    intro(title, { output: PROMPT_OUTPUT });
  },
  outro(message) {
    outro(message, { output: PROMPT_OUTPUT });
  },
  info(message) {
    clackLog.info(message, { output: PROMPT_OUTPUT });
  },
  warn(message) {
    clackLog.warn(message, { output: PROMPT_OUTPUT });
  },
  async select(options) {
    const clackOptions = options.options.map((option) =>
      option.hint
        ? { value: option.value, label: option.label, hint: option.hint }
        : { value: option.value, label: option.label },
    );
    const result = await select({
      message: options.message,
      options: clackOptions,
      output: PROMPT_OUTPUT,
      ...(options.initialValue ? { initialValue: options.initialValue as string } : {}),
    });
    return unwrapPromptResult(result) as (typeof options.options)[number]["value"];
  },
  async text(options) {
    const placeholder = options.placeholder ?? options.defaultValue;
    const result = await text({
      message: options.message,
      output: PROMPT_OUTPUT,
      ...(placeholder ? { placeholder } : {}),
      ...(options.defaultValue !== undefined ? { defaultValue: options.defaultValue } : {}),
      ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
      validate(value) {
        const normalized = value ?? "";
        if (normalized.trim().length === 0 && options.defaultValue !== undefined) {
          return undefined;
        }
        if (options.required && normalized.trim().length === 0) {
          return "此项不能为空";
        }
        return options.validate?.(normalized);
      },
    });
    return unwrapPromptResult(result);
  },
  async password(options) {
    const result = await password({
      message: options.message,
      output: PROMPT_OUTPUT,
      validate(value) {
        const normalized = value ?? "";
        if (options.required && normalized.trim().length === 0) {
          return "此项不能为空";
        }
        return options.validate?.(normalized);
      },
    });
    return unwrapPromptResult(result);
  },
  async confirm(options) {
    const result = await confirm({
      message: options.message,
      output: PROMPT_OUTPUT,
      ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
    });
    return unwrapPromptResult(result);
  },
  async multiselect(options) {
    const clackOptions = options.options.map((option) =>
      option.hint
        ? { value: option.value as string, label: option.label, hint: option.hint }
        : { value: option.value as string, label: option.label },
    );
    const result = await multiselect<string>({
      message: options.message,
      options: clackOptions,
      output: PROMPT_OUTPUT,
      required: options.required ?? false,
      ...(options.initialValues ? { initialValues: [...options.initialValues] } : {}),
    });
    return unwrapPromptResult(result).map(
      (value) => value as (typeof options.options)[number]["value"],
    );
  },
};

function unwrapPromptResult<Value>(result: Value | symbol): Value {
  if (isCancel(result)) {
    cancel("已取消", { output: PROMPT_OUTPUT });
    throw new ConfigSetupCancelledError();
  }
  return result;
}
