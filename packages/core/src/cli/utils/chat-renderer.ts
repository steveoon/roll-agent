import type { Ora } from "ora";
import chalk from "chalk";
import { isCancel, select } from "@clack/prompts";
import { getFileChangeDisplay, type FileChangeDiff, type SessionEvent } from "@roll-agent/runtime";
import { createSpinner, log } from "./output.ts";
import { GLYPHS } from "./glyphs.ts";
import { computeUsageParts, formatUsageLine } from "./token-format.ts";
import {
  formatApprovalDetails,
  formatApprovalExplanation,
  formatToolInput,
} from "./tool-format.ts";
import { formatDebugEvent } from "./debug-format.ts";
import { formatFileChangeDiffLines } from "./unified-diff.ts";
import { DIFF_INLINE_MAX_LINES, type DiffDisplayMode } from "../chat/diff-display.ts";
import type { ChatUserInputPrompt, ChatUserInputResult } from "./user-input-prompts.ts";

type UserInputRequiredEvent = Extract<SessionEvent, { readonly type: "user-input-required" }>;

export interface ChatApprover {
  approve(approvalId: string): void;
  reject(approvalId: string, reason?: string): void;
  resolveUserInput?(
    requestId: UserInputRequiredEvent["requestId"],
    result: ChatUserInputResult,
  ): boolean;
  cancelUserInput?(requestId: UserInputRequiredEvent["requestId"], reason?: string): boolean;
}

export type ChatConfirm = (message: string, signal?: AbortSignal) => Promise<boolean>;

const USER_INPUT_TIMEOUT_REASON = "用户输入请求已超时";
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

interface UserInputPromptSignalScope {
  readonly signal: AbortSignal;
  hasExpired(): boolean;
  dispose(): void;
}

function createUserInputPromptSignalScope(
  expiresAt: string,
  outerSignal: AbortSignal | undefined,
): UserInputPromptSignalScope {
  const deadlineMs = Date.parse(expiresAt);
  const deadlineController = new AbortController();
  let expired = Number.isFinite(deadlineMs) && Date.now() >= deadlineMs;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const expire = (): void => {
    expired = true;
    if (!deadlineController.signal.aborted) {
      deadlineController.abort(new Error(USER_INPUT_TIMEOUT_REASON));
    }
  };
  const scheduleExpiration = (): void => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    deadlineTimer = setTimeout(scheduleExpiration, Math.min(remainingMs, MAX_TIMEOUT_DELAY_MS));
  };
  if (Number.isFinite(deadlineMs)) {
    if (expired) {
      expire();
    } else {
      scheduleExpiration();
    }
  }
  const signal =
    outerSignal === undefined
      ? deadlineController.signal
      : AbortSignal.any([outerSignal, deadlineController.signal]);
  return {
    signal,
    hasExpired() {
      return expired || (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs);
    },
    dispose() {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    },
  };
}

export const clackConfirm: ChatConfirm = async (message, signal) => {
  const answer = await select({
    message,
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    initialValue: "no",
    ...(signal !== undefined ? { signal } : {}),
  });
  return !isCancel(answer) && answer === "yes";
};

export class ChatRenderer {
  private readonly confirm: ChatConfirm;
  private readonly contextWindow: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly userInputPrompt: ChatUserInputPrompt | undefined;
  private readonly spinners = new Map<string, Ora>();
  private readonly toolLabels = new Map<string, string>();
  private compactionSpinner: Ora | undefined;
  private messageSpinner: Ora | undefined;
  private streaming = false;
  private diffDisplayMode: DiffDisplayMode = "collapsed";

  constructor(
    confirm: ChatConfirm,
    contextWindow?: number,
    signal?: AbortSignal,
    userInputPrompt?: ChatUserInputPrompt,
  ) {
    this.confirm = confirm;
    this.contextWindow = contextWindow;
    this.signal = signal;
    this.userInputPrompt = userInputPrompt;
  }

  get diffDisplay(): DiffDisplayMode {
    return this.diffDisplayMode;
  }

  setDiffDisplay(mode: DiffDisplayMode): void {
    this.diffDisplayMode = mode;
  }

  async handle(event: SessionEvent, responder: ChatApprover): Promise<void> {
    switch (event.type) {
      case "debug":
        log.debug(formatDebugEvent(event));
        break;
      case "message-start":
        this.startMessageSpinner();
        break;
      case "text-delta":
        this.stopMessageSpinner();
        process.stdout.write(event.delta);
        this.streaming = true;
        break;
      case "tool-call": {
        this.stopMessageSpinner();
        this.flushLine();
        const label = `${event.agentName}.${event.toolName}`;
        const spinner = createSpinner(
          `${chalk.cyan(label)} ${chalk.gray(formatToolInput(event.input))}`,
        );
        spinner.start();
        this.spinners.set(event.toolCallId, spinner);
        this.toolLabels.set(event.toolCallId, label);
        break;
      }
      case "tool-output-delta": {
        const spinner = this.spinners.get(event.toolCallId);
        const label = this.toolLabels.get(event.toolCallId);
        if (spinner && label) {
          const tail = event.delta
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .at(-1);
          if (tail) {
            const clipped = tail.length > 80 ? `${tail.slice(0, 79)}…` : tail;
            spinner.text = `${chalk.cyan(label)} ${chalk.gray(clipped)}`;
          }
        }
        break;
      }
      case "tool-result": {
        const spinner = this.spinners.get(event.toolCallId);
        if (spinner) {
          if (event.isError) {
            spinner.fail();
          } else {
            spinner.succeed();
          }
          this.spinners.delete(event.toolCallId);
        }
        this.toolLabels.delete(event.toolCallId);
        const fileChange = event.isError ? undefined : getFileChangeDisplay(event.display);
        if (fileChange !== undefined) {
          this.writeDiff(
            fileChange.diff,
            this.diffDisplayMode === "expanded" ? undefined : DIFF_INLINE_MAX_LINES,
            this.diffDisplayMode === "expanded" ? undefined : "/diff on 展开",
          );
        }
        break;
      }
      case "confirmation-required": {
        this.stopMessageSpinner();
        this.flushLine();
        const reason = event.reason ? `（${event.reason}）` : "";
        const header = `执行 ${event.agentName}.${event.toolName}${reason}?`;
        const formattedExplanation =
          event.explanation === undefined
            ? undefined
            : formatApprovalExplanation(event.explanation);
        const explanation =
          formattedExplanation === undefined ? "" : `AI 说明：${formattedExplanation}`;
        const body =
          event.diff !== undefined
            ? formatFileChangeDiffLines(event.diff, {
                color: true,
                ...(this.diffDisplayMode === "expanded"
                  ? {}
                  : { maxBodyLines: DIFF_INLINE_MAX_LINES, collapsedHint: "/diff on 展开" }),
              }).join("\n")
            : formatApprovalDetails(event.input);
        const message = [header, explanation, body].filter((line) => line.length > 0).join("\n");
        const approved = await this.confirm(message, this.signal);
        if (approved) {
          responder.approve(event.approvalId);
        } else {
          responder.reject(event.approvalId, "用户取消");
        }
        break;
      }
      case "user-input-required": {
        this.stopMessageSpinner();
        this.flushLine();
        const promptScope = createUserInputPromptSignalScope(event.expiresAt, this.signal);
        try {
          const result =
            this.userInputPrompt === undefined
              ? ({
                  status: "cancelled",
                  reason: "当前界面不支持用户输入",
                } satisfies ChatUserInputResult)
              : await this.userInputPrompt.request(event.form, promptScope.signal);
          if (promptScope.hasExpired()) {
            if (responder.cancelUserInput === undefined) {
              throw new Error("Chat responder cannot cancel user input");
            }
            responder.cancelUserInput(event.requestId, USER_INPUT_TIMEOUT_REASON);
          } else if (result.status === "submitted") {
            if (responder.resolveUserInput === undefined) {
              throw new Error("Chat responder cannot resolve user input");
            }
            responder.resolveUserInput(event.requestId, result);
          } else {
            if (responder.cancelUserInput === undefined) {
              throw new Error("Chat responder cannot cancel user input");
            }
            responder.cancelUserInput(event.requestId, result.reason);
          }
        } finally {
          promptScope.dispose();
        }
        break;
      }
      case "compaction-start": {
        this.stopMessageSpinner();
        this.flushLine();
        this.compactionSpinner = createSpinner(chalk.gray("压缩上下文中…"));
        this.compactionSpinner.start();
        break;
      }
      case "context-compacted": {
        this.stopCompactionSpinner();
        this.flushLine();
        const label = event.reason === "auto" ? "自动压缩" : "手动压缩";
        const tools = event.truncatedTools
          ? `，精简 ${String(event.truncatedTools)} 个工具结果`
          : "";
        const text =
          event.removed === 0 && !event.truncatedTools
            ? `${GLYPHS.compact} ${label}：无需压缩`
            : `${GLYPHS.compact} ${label}(${event.strategy})：移除 ${String(event.removed)} 条 → 保留 ${String(event.kept)} 条${tools}`;
        process.stderr.write(`${chalk.gray(text)}\n`);
        break;
      }
      case "turn-cancelled":
        this.stopMessageSpinner();
        this.stopCompactionSpinner();
        this.flushLine();
        for (const spinner of this.spinners.values()) {
          spinner.warn(`${spinner.text} ${chalk.yellow("已中断")}`);
        }
        this.spinners.clear();
        this.toolLabels.clear();
        if (event.reason === "user") {
          process.stderr.write(`${chalk.gray(`■ ${event.message}`)}\n`);
        } else if (event.reason === "timeout") {
          log.warn(event.message);
        } else {
          log.error(event.message);
        }
        break;
      case "error":
        this.stopMessageSpinner();
        this.stopCompactionSpinner();
        this.flushLine();
        log.error(event.message);
        break;
      case "message-finish": {
        this.stopMessageSpinner();
        this.flushLine();
        if (event.text.length === 0 && (event.totalUsage?.outputTokens ?? 0) > 0) {
          log.warn("模型本轮只返回了 thinking/reasoning，没有生成可见回复");
        }
        if (event.stoppedAtStepLimit) {
          log.warn(
            "已达单轮最大工具步数，任务可能未完成 — 继续追问即可接着做，或调高 runtime.max-steps",
          );
        }
        const line = formatUsageLine(
          computeUsageParts(
            event.totalUsage,
            event.sessionUsage,
            this.contextWindow,
            event.contextInputTokens,
          ),
        );
        if (line) {
          process.stderr.write(`${chalk.gray(line)}\n`);
        }
        break;
      }
      default:
        break;
    }
  }

  private stopCompactionSpinner(): void {
    if (this.compactionSpinner) {
      this.compactionSpinner.stop();
      this.compactionSpinner = undefined;
    }
  }

  private startMessageSpinner(): void {
    this.stopMessageSpinner();
    this.messageSpinner = createSpinner(chalk.gray("思考中…"));
    this.messageSpinner.start();
  }

  private stopMessageSpinner(): void {
    if (this.messageSpinner) {
      this.messageSpinner.stop();
      this.messageSpinner = undefined;
    }
  }

  private flushLine(): void {
    if (this.streaming) {
      process.stdout.write("\n");
      this.streaming = false;
    }
  }

  private writeDiff(
    diff: FileChangeDiff,
    maxBodyLines: number | undefined,
    hint: string | undefined,
  ): void {
    const lines = formatFileChangeDiffLines(diff, {
      color: true,
      ...(maxBodyLines !== undefined ? { maxBodyLines } : {}),
      ...(hint !== undefined ? { collapsedHint: hint } : {}),
    });
    process.stderr.write(`${lines.join("\n")}\n`);
  }
}
