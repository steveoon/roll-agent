import chalk from "chalk";
import ora from "ora";
import type { Ora } from "ora";

/** 日志级别 */
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

const DEBUG_FLAGS = new Set(["--verbose", "-v"]);
const SENSITIVE_KEY_PATTERN =
  /signed[-_]?envelope|token|secret|password|cookie|authorization|api[-_]?key/i;

/** 全局日志级别，可通过 setLogLevel 修改 */
let currentLevel: LogLevel = "info";

/** 设置全局日志级别 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function isDebugLogEnabled(): boolean {
  return shouldLog("debug");
}

export function resolveLogLevelFromArgv(argv: readonly string[]): LogLevel {
  return argv.some((arg) => DEBUG_FLAGS.has(arg)) ? "debug" : "info";
}

export function redactToolArgsForLog(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return summarizeRedactedValue(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (isRecordObject(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      redacted[entryKey] = redactValue(entryValue, entryKey);
    }
    return redacted;
  }

  return value;
}

function summarizeRedactedValue(value: unknown): string {
  if (typeof value === "string") {
    return `[redacted,len=${value.length}]`;
  }

  const serialized = safeStringify(value);
  return serialized === undefined ? "[redacted]" : `[redacted,len=${serialized.length}]`;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/** 结构化日志输出（写入 stderr，不干扰 stdout 数据流） */
export const log = {
  debug(message: string): void {
    if (shouldLog("debug")) {
      console.error(chalk.gray(`[debug] ${message}`));
    }
  },
  info(message: string): void {
    if (shouldLog("info")) {
      console.error(chalk.blue("→") + ` ${message}`);
    }
  },
  success(message: string): void {
    if (shouldLog("info")) {
      console.error(chalk.green("✓") + ` ${message}`);
    }
  },
  warn(message: string): void {
    if (shouldLog("warn")) {
      console.error(chalk.yellow("⚠") + ` ${message}`);
    }
  },
  error(message: string): void {
    if (shouldLog("error")) {
      console.error(chalk.red("✗") + ` ${message}`);
    }
  },
};

/** 创建 spinner（用于长时间操作的加载动画） */
export function createSpinner(text: string): Ora {
  return ora({ text, stream: process.stderr });
}
