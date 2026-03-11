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

type LogLevel = keyof typeof LOG_LEVELS;

/** 全局日志级别，可通过 setLogLevel 修改 */
let currentLevel: LogLevel = "info";

/** 设置全局日志级别 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
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
