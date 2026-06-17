import type { Ora } from "ora";
import chalk from "chalk";
import { confirm, isCancel } from "@clack/prompts";
import type { SessionEvent, SessionTokenUsage } from "@roll-agent/runtime";
import { createSpinner, log, redactToolArgsForLog } from "./output.ts";

export interface ChatApprover {
  approve(approvalId: string): void;
  reject(approvalId: string, reason?: string): void;
}

export type ChatConfirm = (message: string) => Promise<boolean>;

export const clackConfirm: ChatConfirm = async (message) => {
  const answer = await confirm({ message });
  return !isCancel(answer) && answer === true;
};

function formatInput(input: unknown): string {
  const json = JSON.stringify(redactToolArgsForLog(input));
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

function formatUsage(usage: SessionTokenUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`in ${String(usage.inputTokens)}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`out ${String(usage.outputTokens)}`);
  }
  if (usage.totalTokens !== undefined) {
    parts.push(`total ${String(usage.totalTokens)}`);
  }
  return parts.join(" · ");
}

export class ChatRenderer {
  private readonly confirm: ChatConfirm;
  private readonly spinners = new Map<string, Ora>();
  private streaming = false;

  constructor(confirm: ChatConfirm) {
    this.confirm = confirm;
  }

  async handle(event: SessionEvent, approver: ChatApprover): Promise<void> {
    switch (event.type) {
      case "text-delta":
        process.stdout.write(event.delta);
        this.streaming = true;
        break;
      case "tool-call": {
        this.flushLine();
        const spinner = createSpinner(
          `${chalk.cyan(`${event.agentName}.${event.toolName}`)} ${chalk.gray(formatInput(event.input))}`,
        );
        spinner.start();
        this.spinners.set(event.toolCallId, spinner);
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
        break;
      }
      case "confirmation-required": {
        this.flushLine();
        const reason = event.reason ? `（${event.reason}）` : "";
        const approved = await this.confirm(`执行 ${event.agentName}.${event.toolName}${reason}?`);
        if (approved) {
          approver.approve(event.approvalId);
        } else {
          approver.reject(event.approvalId, "用户取消");
        }
        break;
      }
      case "error":
        this.flushLine();
        log.error(event.message);
        break;
      case "message-finish":
        this.flushLine();
        if (event.totalUsage) {
          log.debug(`tokens: ${formatUsage(event.totalUsage)}`);
        }
        break;
      default:
        break;
    }
  }

  private flushLine(): void {
    if (this.streaming) {
      process.stdout.write("\n");
      this.streaming = false;
    }
  }
}
