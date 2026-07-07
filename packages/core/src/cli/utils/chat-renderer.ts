import type { Ora } from "ora";
import chalk from "chalk";
import { isCancel, select } from "@clack/prompts";
import type { SessionEvent } from "@roll-agent/runtime";
import { createSpinner, log } from "./output.ts";
import { GLYPHS } from "./glyphs.ts";
import { computeUsageParts, formatUsageLine } from "./token-format.ts";
import { formatToolInput, formatApprovalDetails } from "./tool-format.ts";

export interface ChatApprover {
  approve(approvalId: string): void;
  reject(approvalId: string, reason?: string): void;
}

export type ChatConfirm = (message: string) => Promise<boolean>;

export const clackConfirm: ChatConfirm = async (message) => {
  const answer = await select({
    message,
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    initialValue: "no",
  });
  return !isCancel(answer) && answer === "yes";
};

function formatDebugEvent(event: Extract<SessionEvent, { type: "debug" }>): string {
  const parts = [`chat.${event.stage}`, event.message];
  if (event.elapsedMs !== undefined) {
    parts.push(`${String(event.elapsedMs)}ms`);
  }
  if (event.data !== undefined) {
    parts.push(JSON.stringify(event.data));
  }
  return parts.join(" · ");
}

export class ChatRenderer {
  private readonly confirm: ChatConfirm;
  private readonly contextWindow: number | undefined;
  private readonly spinners = new Map<string, Ora>();
  private readonly toolLabels = new Map<string, string>();
  private compactionSpinner: Ora | undefined;
  private messageSpinner: Ora | undefined;
  private streaming = false;

  constructor(confirm: ChatConfirm, contextWindow?: number) {
    this.confirm = confirm;
    this.contextWindow = contextWindow;
  }

  async handle(event: SessionEvent, approver: ChatApprover): Promise<void> {
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
        break;
      }
      case "confirmation-required": {
        this.stopMessageSpinner();
        this.flushLine();
        const reason = event.reason ? `（${event.reason}）` : "";
        const details = formatApprovalDetails(event.input);
        const header = `执行 ${event.agentName}.${event.toolName}${reason}?`;
        const approved = await this.confirm(details ? `${header}\n${details}` : header);
        if (approved) {
          approver.approve(event.approvalId);
        } else {
          approver.reject(event.approvalId, "用户取消");
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
}
