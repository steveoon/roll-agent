import { generateText, type ModelMessage } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ContextCompactionStrategy } from "../types/events.ts";

export interface CompactionInput {
  readonly messages: readonly ModelMessage[];
  readonly strategy: ContextCompactionStrategy;
  readonly keepRecentTurns: number;
  readonly keepRecentTokens: number;
  readonly model: LanguageModelV4;
  readonly abortSignal?: AbortSignal;
}

export interface CompactionResult {
  readonly messages: ModelMessage[];
  readonly removed: number;
  readonly kept: number;
  readonly truncatedTools: number;
}

const MAX_TOOL_RESULT_CHARS = 2000;
const SUMMARY_TIMEOUT_MS = 15_000;
const TOKEN_ESTIMATE_DIVISOR = 3.5;

const SUMMARY_SYSTEM =
  "你在执行上下文 checkpoint 压缩,为另一个将接手这项任务的语言模型撰写交接摘要。请包含:当前进度与已做的关键决定;重要约束、上下文与用户偏好;尚未完成的事项与明确的下一步;继续工作所需的关键数据、示例或引用。简洁、结构化,聚焦于让下一个模型无缝接续,不要寒暄,直接输出摘要正文。";
export const SUMMARY_PREFIX =
  "以下摘要由另一个语言模型在压缩早前对话后产出。请据此继续推进、避免重复已完成的工作:";
export const SUMMARY_ACK = "好的,我已读取之前工作的交接摘要,继续推进。";

export function findTurnBoundaries(messages: readonly ModelMessage[]): number[] {
  const boundaries: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      boundaries.push(index);
    }
  });
  return boundaries;
}

function estimateMessageTokens(message: ModelMessage): number {
  return Math.ceil(JSON.stringify(message).length / TOKEN_ESTIMATE_DIVISOR);
}

function turnFloorCut(boundaries: readonly number[], keepRecentTurns: number): number {
  if (boundaries.length <= keepRecentTurns) {
    return 0;
  }
  return boundaries[boundaries.length - keepRecentTurns] ?? 0;
}

function tokenBudgetCut(
  messages: readonly ModelMessage[],
  boundaries: readonly number[],
  keepRecentTokens: number,
): number {
  let cut = boundaries[boundaries.length - 1] ?? 0;
  let kept = 0;
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    const start = boundaries[i] ?? 0;
    const end =
      i + 1 < boundaries.length ? (boundaries[i + 1] ?? messages.length) : messages.length;
    let turnTokens = 0;
    for (let j = start; j < end; j += 1) {
      const message = messages[j];
      if (message !== undefined) {
        turnTokens += estimateMessageTokens(message);
      }
    }
    if (i < boundaries.length - 1 && kept + turnTokens > keepRecentTokens) {
      return boundaries[i + 1] ?? start;
    }
    kept += turnTokens;
    cut = start;
  }
  return cut;
}

function cutIndex(
  messages: readonly ModelMessage[],
  keepRecentTurns: number,
  keepRecentTokens: number,
): number {
  const boundaries = findTurnBoundaries(messages);
  if (boundaries.length === 0) {
    return 0;
  }
  return Math.min(
    tokenBudgetCut(messages, boundaries, keepRecentTokens),
    turnFloorCut(boundaries, keepRecentTurns),
  );
}

function renderPart(part: unknown): string {
  if (typeof part !== "object" || part === null) {
    return "";
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  if (record.type === "tool-call" && typeof record.toolName === "string") {
    return `[调用 ${record.toolName}]`;
  }
  if (record.type === "tool-result") {
    return "[工具结果]";
  }
  return "";
}

function renderMessage(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === "string") {
    return `${message.role}: ${content}`;
  }
  const text = content
    .map(renderPart)
    .filter((value) => value.length > 0)
    .join(" ");
  return `${message.role}: ${text}`;
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new Error("aborted");
  }
}

async function summarizePrefix(
  prefix: readonly ModelMessage[],
  model: LanguageModelV4,
  abortSignal: AbortSignal | undefined,
): Promise<ModelMessage[]> {
  const transcript = prefix.map(renderMessage).join("\n\n");
  const { text } = await generateText({
    model,
    system: SUMMARY_SYSTEM,
    prompt: transcript,
    maxOutputTokens: 1024,
    maxRetries: 0,
    ...(abortSignal ? { abortSignal } : {}),
    timeout: { totalMs: SUMMARY_TIMEOUT_MS },
  });
  return [
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${text}` },
    { role: "assistant", content: SUMMARY_ACK },
  ];
}

function truncateToolResults(messages: readonly ModelMessage[]): {
  messages: ModelMessage[];
  truncated: number;
} {
  let truncated = 0;
  const out = messages.map((message): ModelMessage => {
    if (message.role !== "tool") {
      return message;
    }
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      const serialized = JSON.stringify(part.output);
      if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
        return part;
      }
      truncated += 1;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `[已省略 ${String(serialized.length)} 字符的工具结果，如需最新内容请重新调用对应工具]`,
        },
      };
    });
    return { ...message, content };
  });
  return { messages: out, truncated };
}

export async function compactMessages(input: CompactionInput): Promise<CompactionResult> {
  throwIfAborted(input.abortSignal);
  const cut = cutIndex(input.messages, input.keepRecentTurns, input.keepRecentTokens);
  if (cut === 0) {
    const { messages, truncated } = truncateToolResults(input.messages);
    return { messages, removed: 0, kept: messages.length, truncatedTools: truncated };
  }
  const prefix = input.messages.slice(0, cut);
  const suffix = input.messages.slice(cut);
  const { messages: keptSuffix, truncated } = truncateToolResults(suffix);
  const head =
    input.strategy === "summarize"
      ? await summarizePrefix(prefix, input.model, input.abortSignal)
      : [];
  throwIfAborted(input.abortSignal);
  return {
    messages: [...head, ...keptSuffix],
    removed: prefix.length,
    kept: keptSuffix.length,
    truncatedTools: truncated,
  };
}
