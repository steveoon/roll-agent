import type { ConfigFieldWidget, ConfigPath } from "../types.ts";
import { isCompleteEnvReference } from "./input-validation.ts";

const NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 3,
});

const BYTE_UNITS = [
  { size: 1024 ** 4, label: "TB" },
  { size: 1024 ** 3, label: "GB" },
  { size: 1024 ** 2, label: "MB" },
  { size: 1024, label: "KB" },
] as const;

export interface FormatConfigValueOptions {
  readonly path?: ConfigPath;
  readonly widget?: ConfigFieldWidget;
  readonly secret?: boolean;
  readonly configuredSecret?: boolean;
}

export interface DescribeFieldStateInput {
  readonly present: boolean;
  readonly value: unknown;
  readonly defaultValue?: unknown;
  readonly configuredSecret: boolean;
  readonly secret: boolean;
  readonly required: boolean;
  readonly widget: ConfigFieldWidget;
  readonly path: ConfigPath;
}

export interface FieldStateDescription {
  readonly currentLabel: string;
  readonly sourceLabel: string;
  readonly resetLabel: string;
}

/**
 * Turns a raw configuration value into a short, non-sensitive label for the UI.
 */
export function formatConfigValue(value: unknown, options: FormatConfigValueOptions = {}): string {
  if (options.configuredSecret === true) return "已安全配置";
  if (options.secret === true) return value === undefined ? "未设置" : "已填写敏感值";
  if (value === undefined) return "未设置";
  if (value === null) return "空值";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (typeof value === "number") {
    if (isDurationPath(options)) return formatDuration(value);
    if (isBytePath(options.path)) return formatBytes(value);
    return NUMBER_FORMATTER.format(value);
  }
  if (typeof value === "string") {
    if (isCompleteEnvReference(value)) return `环境变量 ${value.slice(2, -1)}`;
    return value.length === 0 ? "空字符串" : value;
  }
  if (Array.isArray(value)) return value.length === 0 ? "空列表" : `${String(value.length)} 项`;
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    return count === 0 ? "空对象" : `${String(count)} 项配置`;
  }
  return "无法显示";
}

/**
 * Describes what the user currently gets, where it comes from, and what reset does.
 */
export function describeFieldState(input: DescribeFieldStateInput): FieldStateDescription {
  const resetLabel = getResetLabel(input);

  if (input.configuredSecret) {
    return {
      currentLabel: "已安全配置",
      sourceLabel: "来自 roll.config（内容已隐藏）",
      resetLabel,
    };
  }

  if (input.present) {
    if (typeof input.value === "string" && isCompleteEnvReference(input.value)) {
      return {
        currentLabel: "已使用环境变量",
        sourceLabel: formatConfigValue(input.value),
        resetLabel,
      };
    }

    if (input.secret) {
      return {
        currentLabel: "已填写敏感值",
        sourceLabel: "来自 roll.config（内容已隐藏）",
        resetLabel,
      };
    }

    return {
      currentLabel: `已自定义：${formatConfigValue(input.value, input)}`,
      sourceLabel:
        input.defaultValue !== undefined && sameConfigValue(input.value, input.defaultValue)
          ? "来自 roll.config（与默认值相同）"
          : "来自 roll.config",
      resetLabel,
    };
  }

  if (input.defaultValue !== undefined) {
    return {
      currentLabel: input.secret
        ? "使用默认敏感值"
        : `使用默认值：${formatConfigValue(input.defaultValue, input)}`,
      sourceLabel: "来自内置默认值",
      resetLabel,
    };
  }

  return {
    currentLabel: input.required ? "尚未设置（必填）" : "未设置",
    sourceLabel: input.required ? "需要手动配置" : "未写入 roll.config",
    resetLabel,
  };
}

/**
 * Compares JSON-like configuration data without depending on object key order.
 */
export function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameConfigValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && sameConfigValue(left[key], right[key]),
  );
}

function getResetLabel(input: DescribeFieldStateInput): string {
  if (input.defaultValue !== undefined) return "恢复默认值";
  if (input.secret) return "清除敏感配置";
  return "移除自定义值";
}

function isDurationPath(options: FormatConfigValueOptions): boolean {
  if (options.widget === "duration") return true;
  const segment = options.path?.at(-1);
  return typeof segment === "string" && segment.endsWith("Ms");
}

function isBytePath(path: ConfigPath | undefined): boolean {
  const segment = path?.at(-1);
  return typeof segment === "string" && segment.endsWith("Bytes");
}

function formatDuration(milliseconds: number): string {
  const absolute = Math.abs(milliseconds);
  const unit =
    absolute >= 3_600_000
      ? { divisor: 3_600_000, label: "小时" }
      : absolute >= 60_000
        ? { divisor: 60_000, label: "分钟" }
        : { divisor: 1000, label: "秒" };
  return `${NUMBER_FORMATTER.format(milliseconds / unit.divisor)} ${unit.label}（${NUMBER_FORMATTER.format(milliseconds)} ms）`;
}

function formatBytes(bytes: number): string {
  const absolute = Math.abs(bytes);
  const unit = BYTE_UNITS.find((candidate) => absolute >= candidate.size);
  if (unit === undefined) return `${NUMBER_FORMATTER.format(bytes)} bytes`;
  return `${NUMBER_FORMATTER.format(bytes / unit.size)} ${unit.label}（${NUMBER_FORMATTER.format(bytes)} bytes）`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
