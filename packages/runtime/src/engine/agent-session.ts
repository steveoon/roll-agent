import { randomUUID } from "node:crypto";
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { LanguageModelV3, SharedV3ProviderOptions } from "@ai-sdk/provider";
import type {
  ContextCompactionReason,
  ContextCompactionStrategy,
  SessionDebugData,
  SessionDebugStage,
  SessionEvent,
  SessionTokenUsage,
} from "../types/events.ts";
import type { ToolPolicy } from "../types/policy.ts";
import {
  buildAgentToolset,
  type AgentToolSource,
  type ApprovalRequest,
} from "../tool-bridge/build-tools.ts";
import type { ToolRegistry } from "../tool-bridge/naming.ts";
import { readIsError } from "../tool-bridge/normalize-result.ts";
import { ApprovalGate, type ApprovalDecision } from "../approval/approval-gate.ts";
import { compactMessages } from "./compactor.ts";
import { AsyncEventQueue } from "./event-queue.ts";

export interface SessionCompactionSettings {
  readonly enabled: boolean;
  readonly strategy: ContextCompactionStrategy;
  readonly threshold: number;
  readonly keepRecentTurns: number;
  readonly keepRecentTokens: number;
}

export interface AgentSessionOptions {
  readonly id: string;
  readonly model: LanguageModelV3;
  readonly sources: readonly AgentToolSource[];
  readonly maxSteps: number;
  readonly policy?: ToolPolicy;
  readonly initialMessages?: readonly ModelMessage[];
  readonly onPersist?: (messages: readonly ModelMessage[]) => void;
  readonly onReplace?: (messages: readonly ModelMessage[]) => void;
  readonly contextWindow?: number;
  readonly compaction?: SessionCompactionSettings;
  readonly turnTimeoutMs?: number;
  readonly providerOptions?: SharedV3ProviderOptions;
  readonly debugEvents?: boolean;
}

const CHAT_SYSTEM_PROMPT =
  "你是 Roll chat 的运行时助手。你可以使用模型的 thinking/reasoning 能力完成内部推理，" +
  "但必须把给用户看的最终回复写入普通 text 输出通道；不要只在 reasoning 中写最终答案。 " +
  "工具调用完成后，也要在普通 text 输出通道给出简洁结论。最终回复不要重复。 " +
  "不要复述用户输入；如果需要调用工具，直接调用工具，不要先输出用户原文或无意义前置文本。";

interface ActiveTurn {
  readonly abortController: AbortController;
  aborted: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasToolOutput(value: unknown): value is { readonly output: unknown } {
  return typeof value === "object" && value !== null && "output" in value;
}

function toolOutputMessage(value: unknown): string {
  return hasToolOutput(value) ? errorMessage(value.output) : errorMessage(value);
}

function toolDenialMessage(value: unknown): string | undefined {
  const message = toolOutputMessage(value);
  return message.startsWith("已取消执行") || message.startsWith("策略拒绝执行")
    ? message
    : undefined;
}

function isContextWindowError(error: unknown): boolean {
  return /context[_ -]?length|context window|maximum context|token limit|too many tokens|prompt is too long|input is too long/i.test(
    errorMessage(error),
  );
}

function toSessionUsage(usage: LanguageModelUsage): SessionTokenUsage {
  const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function addOptionalTokens(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function addUsage(acc: SessionTokenUsage, next: SessionTokenUsage): SessionTokenUsage {
  const cachedInputTokens = addOptionalTokens(acc.cachedInputTokens, next.cachedInputTokens);
  const reasoningTokens = addOptionalTokens(acc.reasoningTokens, next.reasoningTokens);
  return {
    inputTokens: (acc.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (acc.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (next.totalTokens ?? 0),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function maxTokenCount(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) {
    return current;
  }
  return current === undefined ? next : Math.max(current, next);
}

function isPotentialInputEcho(candidate: string, input: string): boolean {
  const normalizedCandidate = candidate.trim();
  const normalizedInput = input.trim();
  return (
    normalizedCandidate.length > 0 &&
    normalizedInput.length > 0 &&
    normalizedInput.startsWith(normalizedCandidate)
  );
}

function stripReasoningMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message];
    }

    const content = message.content.filter((part) => part.type !== "reasoning");
    if (content.length === 0) {
      return [];
    }
    if (content.length === message.content.length) {
      return [message];
    }
    return [{ ...message, content }];
  });
}

export class AgentSession {
  readonly id: string;
  private readonly model: LanguageModelV3;
  private readonly maxSteps: number;
  private readonly messages: ModelMessage[];
  private readonly onPersist: ((messages: readonly ModelMessage[]) => void) | undefined;
  private readonly onReplace: ((messages: readonly ModelMessage[]) => void) | undefined;
  private readonly contextWindow: number | undefined;
  private readonly compaction: SessionCompactionSettings | undefined;
  private readonly turnTimeoutMs: number | undefined;
  private providerOptions: SharedV3ProviderOptions | undefined;
  private readonly debugEvents: boolean;
  private readonly gate = new ApprovalGate();
  private readonly tools: ToolSet;
  private readonly registry: ToolRegistry;
  private emit: ((event: SessionEvent) => void) | undefined;
  private activeTurn: ActiveTurn | undefined;
  private sessionUsage: SessionTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private lastInputTokens: number | undefined;
  private needsCompaction = false;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.model = options.model;
    this.maxSteps = options.maxSteps;
    this.messages = options.initialMessages ? stripReasoningMessages(options.initialMessages) : [];
    this.onPersist = options.onPersist;
    this.onReplace = options.onReplace;
    this.contextWindow = options.contextWindow;
    this.compaction = options.compaction;
    this.turnTimeoutMs = options.turnTimeoutMs;
    this.providerOptions = options.providerOptions;
    this.debugEvents = options.debugEvents ?? false;
    const built = buildAgentToolset(options.sources, {
      ...(options.policy ? { policy: options.policy } : {}),
      requestApproval: (request) => this.requestApproval(request),
    });
    this.tools = built.tools;
    this.registry = built.registry;
  }

  async *send(input: string): AsyncIterable<SessionEvent> {
    if (this.activeTurn) {
      throw new Error("session already has an active turn");
    }

    const queue = new AsyncEventQueue<SessionEvent>();
    this.emit = (event) => queue.push(event);
    const abortController = new AbortController();
    const activeTurn: ActiveTurn = { abortController, aborted: false };
    this.activeTurn = activeTurn;

    this.runTurn(queue, activeTurn, input).catch((error: unknown) => {
      queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
      queue.close();
    });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      if (this.activeTurn === activeTurn) {
        this.abort();
      }
      if (this.emit !== undefined) {
        this.emit = undefined;
      }
    }
  }

  async *compact(reason: ContextCompactionReason = "manual"): AsyncIterable<SessionEvent> {
    if (this.activeTurn) {
      throw new Error("session already has an active turn");
    }

    const queue = new AsyncEventQueue<SessionEvent>();
    this.emit = (event) => queue.push(event);
    const abortController = new AbortController();
    const activeTurn: ActiveTurn = { abortController, aborted: false };
    this.activeTurn = activeTurn;

    this.runCompactionTurn(queue, activeTurn, reason).catch((error: unknown) => {
      queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
      queue.close();
    });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      if (this.activeTurn === activeTurn) {
        this.abort();
      }
      if (this.emit !== undefined) {
        this.emit = undefined;
      }
    }
  }

  private async runTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    input: string,
  ): Promise<void> {
    const turnStartedAt = Date.now();
    let turnStart: number | undefined;
    try {
      this.debug(queue, "turn", "start", turnStartedAt, {
        messages: this.messages.length,
        tools: Object.keys(this.tools).length,
        maxSteps: this.maxSteps,
        ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
        ...(this.lastInputTokens !== undefined ? { lastInputTokens: this.lastInputTokens } : {}),
      });
      if (this.shouldAutoCompact()) {
        this.debug(queue, "compaction", "auto requested before turn", turnStartedAt, {
          messages: this.messages.length,
          ...(this.lastInputTokens !== undefined ? { lastInputTokens: this.lastInputTokens } : {}),
        });
        try {
          await this.runCompaction(queue, "auto", activeTurn);
        } catch (error) {
          queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
          return;
        }
      }
      if (activeTurn.aborted || activeTurn.abortController.signal.aborted) {
        queue.push({ type: "error", stage: "execute", message: "aborted" });
        return;
      }

      turnStart = this.messages.length;
      this.messages.push({ role: "user", content: input });
      queue.push({ type: "message-start", messageId: randomUUID() });
      this.debug(queue, "model", "calling streamText", turnStartedAt, {
        messages: this.messages.length,
        tools: Object.keys(this.tools).length,
        ...(this.turnTimeoutMs !== undefined ? { timeoutMs: this.turnTimeoutMs } : {}),
      });
      const result = streamText({
        model: this.model,
        system: CHAT_SYSTEM_PROMPT,
        messages: this.messages,
        tools: this.tools,
        stopWhen: stepCountIs(this.maxSteps),
        abortSignal: activeTurn.abortController.signal,
        ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
        ...(this.turnTimeoutMs !== undefined ? { timeout: { totalMs: this.turnTimeoutMs } } : {}),
      });
      this.debug(queue, "model", "streamText returned", turnStartedAt);

      let text = "";
      let pendingEchoText = "";
      let sawToolCall = false;
      let totalUsage: SessionTokenUsage | undefined;
      let contextInputTokens: number | undefined;
      let stepCount = 0;
      let lastStepFinishReason: string | undefined;
      let streamError: string | undefined;
      let terminalToolDenial: string | undefined;
      let firstPartSeen = false;
      const firstPartTimer = this.scheduleDebug(
        queue,
        "model",
        "waiting for first stream event",
        turnStartedAt,
        { messages: this.messages.length },
      );
      try {
        for await (const part of result.fullStream) {
          if (!firstPartSeen) {
            firstPartSeen = true;
            this.clearDebugTimer(firstPartTimer);
            this.debug(queue, "model", "first stream event", turnStartedAt, { part: part.type });
          }
          switch (part.type) {
            case "text-delta": {
              if (!sawToolCall) {
                const candidate = pendingEchoText + part.text;
                if (isPotentialInputEcho(candidate, input)) {
                  pendingEchoText = candidate;
                  break;
                }
                if (pendingEchoText.length > 0) {
                  const delta = pendingEchoText + part.text;
                  pendingEchoText = "";
                  text += delta;
                  queue.push({ type: "text-delta", delta });
                  break;
                }
              }
              text += part.text;
              queue.push({ type: "text-delta", delta: part.text });
              break;
            }
            case "tool-call": {
              sawToolCall = true;
              pendingEchoText = "";
              const route = this.registry.resolve(part.toolName);
              queue.push({
                type: "tool-call",
                toolCallId: part.toolCallId,
                agentName: route?.agentName ?? part.toolName,
                toolName: route?.toolName ?? part.toolName,
                input: part.input,
              });
              break;
            }
            case "tool-result": {
              const route = this.registry.resolve(part.toolName);
              const isError = readIsError(part.output);
              queue.push({
                type: "tool-result",
                toolCallId: part.toolCallId,
                agentName: route?.agentName ?? part.toolName,
                toolName: route?.toolName ?? part.toolName,
                output: part.output,
                isError,
              });
              if (!activeTurn.aborted && !activeTurn.abortController.signal.aborted && isError) {
                terminalToolDenial = toolDenialMessage(part.output);
              }
              break;
            }
            case "tool-error": {
              const route = this.registry.resolve(part.toolName);
              const output = toolOutputMessage(part.error);
              queue.push({
                type: "tool-result",
                toolCallId: part.toolCallId,
                agentName: route?.agentName ?? part.toolName,
                toolName: route?.toolName ?? part.toolName,
                output,
                isError: true,
              });
              if (!activeTurn.aborted && !activeTurn.abortController.signal.aborted) {
                terminalToolDenial = toolDenialMessage(part.error);
              }
              break;
            }
            case "finish-step": {
              const stepUsage = toSessionUsage(part.usage);
              contextInputTokens = maxTokenCount(contextInputTokens, stepUsage.inputTokens);
              stepCount += 1;
              lastStepFinishReason = part.finishReason;
              queue.push({
                type: "step-finish",
                finishReason: part.finishReason,
                usage: stepUsage,
              });
              break;
            }
            case "finish":
              if (!sawToolCall && pendingEchoText.length > 0) {
                text += pendingEchoText;
                queue.push({ type: "text-delta", delta: pendingEchoText });
                pendingEchoText = "";
              }
              totalUsage = toSessionUsage(part.totalUsage);
              break;
            case "error":
              if (isContextWindowError(part.error)) {
                this.needsCompaction = true;
              }
              streamError = errorMessage(part.error);
              queue.push({ type: "error", stage: "execute", message: streamError });
              break;
            case "abort":
              activeTurn.aborted = true;
              break;
            default:
              break;
          }
          if (terminalToolDenial !== undefined) {
            break;
          }
        }
      } finally {
        this.clearDebugTimer(firstPartTimer);
      }
      this.debug(queue, "model", "fullStream finished", turnStartedAt, {
        textChars: text.length,
      });

      if (streamError !== undefined) {
        this.messages.splice(turnStart);
        if (this.needsCompaction) {
          await this.recoverFromContextError(queue, activeTurn);
        }
        return;
      }

      if (activeTurn.aborted || activeTurn.abortController.signal.aborted) {
        this.messages.splice(turnStart);
        queue.push({ type: "error", stage: "execute", message: "aborted" });
        return;
      }

      if (terminalToolDenial !== undefined) {
        const cancellationText = terminalToolDenial;
        const delta = text.length === 0 ? cancellationText : `\n${cancellationText}`;
        queue.push({ type: "text-delta", delta });
        this.messages.push({ role: "assistant", content: cancellationText });
        this.debug(queue, "persist", "persisting messages", turnStartedAt, {
          appendedMessages: this.messages.length - turnStart,
        });
        this.onPersist?.(this.messages.slice(turnStart));
        this.debug(queue, "persist", "messages persisted", turnStartedAt, {
          totalMessages: this.messages.length,
        });
        if (totalUsage) {
          this.sessionUsage = addUsage(this.sessionUsage, totalUsage);
        }
        const pressureInputTokens = contextInputTokens ?? totalUsage?.inputTokens;
        if (pressureInputTokens !== undefined) {
          this.lastInputTokens = pressureInputTokens;
        }
        queue.push({
          type: "message-finish",
          text: cancellationText,
          ...(totalUsage ? { totalUsage } : {}),
          sessionUsage: { ...this.sessionUsage },
          ...(contextInputTokens !== undefined ? { contextInputTokens } : {}),
        });
        return;
      }

      let responseMessages: ModelMessage[];
      this.debug(queue, "model", "awaiting response messages", turnStartedAt);
      const responseTimer = this.scheduleDebug(
        queue,
        "model",
        "still awaiting response messages",
        turnStartedAt,
      );
      try {
        const response = await result.response;
        responseMessages = response.messages;
      } catch (error) {
        this.clearDebugTimer(responseTimer);
        if (isContextWindowError(error)) {
          this.needsCompaction = true;
        }
        this.messages.splice(turnStart);
        queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
        if (this.needsCompaction) {
          await this.recoverFromContextError(queue, activeTurn);
        }
        return;
      } finally {
        this.clearDebugTimer(responseTimer);
      }
      this.debug(queue, "model", "response messages ready", turnStartedAt, {
        responseMessages: responseMessages.length,
      });

      const visibleResponseMessages = stripReasoningMessages(responseMessages);
      this.messages.push(...visibleResponseMessages);
      this.debug(queue, "persist", "persisting messages", turnStartedAt, {
        appendedMessages: this.messages.length - turnStart,
      });
      this.onPersist?.(this.messages.slice(turnStart));
      this.debug(queue, "persist", "messages persisted", turnStartedAt, {
        totalMessages: this.messages.length,
      });
      if (totalUsage) {
        this.sessionUsage = addUsage(this.sessionUsage, totalUsage);
      }
      const pressureInputTokens = contextInputTokens ?? totalUsage?.inputTokens;
      if (pressureInputTokens !== undefined) {
        this.lastInputTokens = pressureInputTokens;
      }
      const stoppedAtStepLimit = stepCount >= this.maxSteps && lastStepFinishReason === "tool-calls";
      queue.push({
        type: "message-finish",
        text,
        ...(totalUsage ? { totalUsage } : {}),
        sessionUsage: { ...this.sessionUsage },
        ...(contextInputTokens !== undefined ? { contextInputTokens } : {}),
        ...(stoppedAtStepLimit ? { stoppedAtStepLimit: true } : {}),
      });
    } catch (error) {
      if (turnStart !== undefined) {
        this.messages.splice(turnStart);
      }
      if (isContextWindowError(error)) {
        this.needsCompaction = true;
      }
      this.debug(queue, "turn", "error", turnStartedAt, { message: errorMessage(error) });
      queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
      if (this.needsCompaction) {
        await this.recoverFromContextError(queue, activeTurn);
      }
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
      }
      queue.close();
    }
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    const decision = this.gate.request(approvalId);
    if (this.emit === undefined) {
      this.gate.resolve(approvalId, {
        approved: false,
        reason: "approval event could not be delivered",
      });
      return decision;
    }

    this.emit({
      type: "confirmation-required",
      approvalId,
      agentName: request.agentName,
      toolName: request.toolName,
      input: request.input,
      ...(request.reason ? { reason: request.reason } : {}),
    });
    return decision;
  }

  approve(approvalId: string): boolean {
    return this.gate.resolve(approvalId, { approved: true });
  }

  reject(approvalId: string, reason?: string): boolean {
    return this.gate.resolve(approvalId, { approved: false, ...(reason ? { reason } : {}) });
  }

  getMessages(): readonly ModelMessage[] {
    return this.messages;
  }

  getContextWindow(): number | undefined {
    return this.contextWindow;
  }

  getSessionUsage(): SessionTokenUsage {
    return { ...this.sessionUsage };
  }

  setProviderOptions(providerOptions: SharedV3ProviderOptions | undefined): void {
    this.providerOptions = providerOptions;
  }

  private shouldAutoCompact(): boolean {
    const settings = this.compaction;
    return (
      settings !== undefined &&
      settings.enabled &&
      (this.needsCompaction ||
        (this.contextWindow !== undefined &&
          this.lastInputTokens !== undefined &&
          this.lastInputTokens / this.contextWindow >= settings.threshold))
    );
  }

  private async runCompactionTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    reason: ContextCompactionReason,
  ): Promise<void> {
    try {
      await this.runCompaction(queue, reason, activeTurn);
    } catch (error) {
      queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
      }
      queue.close();
    }
  }

  private async runCompaction(
    queue: AsyncEventQueue<SessionEvent>,
    reason: ContextCompactionReason,
    activeTurn?: ActiveTurn,
  ): Promise<void> {
    const startedAt = Date.now();
    const settings = this.compaction;
    const defaultStrategy = settings?.strategy ?? "summarize";
    this.debug(queue, "compaction", "start", startedAt, {
      reason,
      messages: this.messages.length,
    });
    queue.push({ type: "compaction-start", reason });
    if (this.isTurnAborted(activeTurn)) {
      queue.push({ type: "error", stage: "plan", message: "aborted" });
      return;
    }
    if (!settings) {
      queue.push({
        type: "context-compacted",
        reason,
        strategy: defaultStrategy,
        removed: 0,
        kept: this.messages.length,
      });
      return;
    }

    const before = this.lastInputTokens;
    let strategy = settings.strategy;
    const abortSignal = activeTurn?.abortController.signal;
    let result: Awaited<ReturnType<typeof compactMessages>>;
    try {
      result = await compactMessages({
        messages: this.messages,
        strategy,
        keepRecentTurns: settings.keepRecentTurns,
        keepRecentTokens: settings.keepRecentTokens,
        model: this.model,
        ...(abortSignal ? { abortSignal } : {}),
      });
    } catch (error) {
      if (this.isTurnAborted(activeTurn)) {
        queue.push({ type: "error", stage: "plan", message: "aborted" });
        return;
      }
      if (strategy !== "summarize") {
        throw error;
      }
      this.debug(queue, "compaction", "summarize failed, fallback to truncate", startedAt, {
        message: errorMessage(error),
      });
      strategy = "truncate";
      result = await compactMessages({
        messages: this.messages,
        strategy,
        keepRecentTurns: settings.keepRecentTurns,
        keepRecentTokens: settings.keepRecentTokens,
        model: this.model,
        ...(abortSignal ? { abortSignal } : {}),
      });
    }

    if (this.isTurnAborted(activeTurn)) {
      queue.push({ type: "error", stage: "plan", message: "aborted" });
      return;
    }

    const progressed = result.removed > 0 || result.truncatedTools > 0;
    if (progressed) {
      this.onReplace?.(result.messages);
      this.messages.splice(0, this.messages.length, ...result.messages);
      this.lastInputTokens = undefined;
      this.needsCompaction = false;
    }

    queue.push({
      type: "context-compacted",
      reason,
      strategy,
      removed: result.removed,
      kept: result.kept,
      ...(result.truncatedTools > 0 ? { truncatedTools: result.truncatedTools } : {}),
      ...(before !== undefined ? { beforeInputTokens: before } : {}),
    });
    this.debug(queue, "compaction", "finish", startedAt, {
      reason,
      strategy,
      removed: result.removed,
      kept: result.kept,
      truncatedTools: result.truncatedTools,
      progressed,
    });
  }

  private async recoverFromContextError(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn?: ActiveTurn,
  ): Promise<void> {
    if (!this.compaction?.enabled) {
      return;
    }
    try {
      await this.runCompaction(queue, "auto", activeTurn);
    } catch (error) {
      queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
    }
  }

  private isTurnAborted(activeTurn: ActiveTurn | undefined): boolean {
    return activeTurn?.aborted === true || activeTurn?.abortController.signal.aborted === true;
  }

  abort(): void {
    if (this.activeTurn) {
      this.activeTurn.aborted = true;
    }
    this.gate.abortAll();
    this.activeTurn?.abortController.abort();
  }

  private debug(
    queue: AsyncEventQueue<SessionEvent>,
    stage: SessionDebugStage,
    message: string,
    startedAt?: number,
    data?: SessionDebugData,
  ): void {
    if (!this.debugEvents) {
      return;
    }
    queue.push({
      type: "debug",
      stage,
      message,
      ...(startedAt !== undefined ? { elapsedMs: Date.now() - startedAt } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  }

  private scheduleDebug(
    queue: AsyncEventQueue<SessionEvent>,
    stage: SessionDebugStage,
    message: string,
    startedAt: number,
    data?: SessionDebugData,
  ): ReturnType<typeof setTimeout> | undefined {
    if (!this.debugEvents) {
      return undefined;
    }
    return setTimeout(() => {
      this.debug(queue, stage, message, startedAt, data);
    }, 5_000);
  }

  private clearDebugTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
