import { randomUUID } from "node:crypto";
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { SessionEvent, SessionTokenUsage } from "../types/events.ts";
import type { ToolPolicy } from "../types/policy.ts";
import {
  buildAgentToolset,
  type AgentToolSource,
  type ApprovalRequest,
} from "../tool-bridge/build-tools.ts";
import type { ToolRegistry } from "../tool-bridge/naming.ts";
import { readIsError } from "../tool-bridge/normalize-result.ts";
import { ApprovalGate, type ApprovalDecision } from "../approval/approval-gate.ts";
import { AsyncEventQueue } from "./event-queue.ts";

export interface AgentSessionOptions {
  readonly id: string;
  readonly model: LanguageModelV3;
  readonly sources: readonly AgentToolSource[];
  readonly maxSteps: number;
  readonly policy?: ToolPolicy;
  readonly initialMessages?: readonly ModelMessage[];
  readonly onPersist?: (messages: readonly ModelMessage[]) => void;
}

interface ActiveTurn {
  readonly abortController: AbortController;
  aborted: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSessionUsage(usage: LanguageModelUsage): SessionTokenUsage {
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  };
}

export class AgentSession {
  readonly id: string;
  private readonly model: LanguageModelV3;
  private readonly maxSteps: number;
  private readonly messages: ModelMessage[];
  private readonly onPersist: ((messages: readonly ModelMessage[]) => void) | undefined;
  private readonly gate = new ApprovalGate();
  private readonly tools: ToolSet;
  private readonly registry: ToolRegistry;
  private emit: ((event: SessionEvent) => void) | undefined;
  private activeTurn: ActiveTurn | undefined;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.model = options.model;
    this.maxSteps = options.maxSteps;
    this.messages = options.initialMessages ? [...options.initialMessages] : [];
    this.onPersist = options.onPersist;
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
    const turnStart = this.messages.length;
    this.messages.push({ role: "user", content: input });
    const abortController = new AbortController();
    const activeTurn: ActiveTurn = { abortController, aborted: false };
    this.activeTurn = activeTurn;

    this.runTurn(queue, activeTurn, turnStart).catch((error: unknown) => {
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

  private async runTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    turnStart: number,
  ): Promise<void> {
    try {
      queue.push({ type: "message-start", messageId: randomUUID() });
      const result = streamText({
        model: this.model,
        messages: this.messages,
        tools: this.tools,
        stopWhen: stepCountIs(this.maxSteps),
        abortSignal: activeTurn.abortController.signal,
      });

      let text = "";
      let totalUsage: SessionTokenUsage | undefined;
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            text += part.text;
            queue.push({ type: "text-delta", delta: part.text });
            break;
          case "tool-call": {
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
            queue.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              agentName: route?.agentName ?? part.toolName,
              toolName: route?.toolName ?? part.toolName,
              output: part.output,
              isError: readIsError(part.output),
            });
            break;
          }
          case "tool-error": {
            const route = this.registry.resolve(part.toolName);
            queue.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              agentName: route?.agentName ?? part.toolName,
              toolName: route?.toolName ?? part.toolName,
              output: errorMessage(part.error),
              isError: true,
            });
            break;
          }
          case "finish-step":
            queue.push({
              type: "step-finish",
              finishReason: part.finishReason,
              usage: toSessionUsage(part.usage),
            });
            break;
          case "finish":
            totalUsage = toSessionUsage(part.totalUsage);
            break;
          case "error":
            queue.push({ type: "error", stage: "execute", message: errorMessage(part.error) });
            break;
          case "abort":
            activeTurn.aborted = true;
            break;
          default:
            break;
        }
      }

      if (activeTurn.aborted || activeTurn.abortController.signal.aborted) {
        this.messages.splice(turnStart);
        queue.push({ type: "error", stage: "execute", message: "aborted" });
        return;
      }

      let responseMessages: ModelMessage[];
      try {
        const response = await result.response;
        responseMessages = response.messages;
      } catch (error) {
        this.messages.splice(turnStart);
        queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
        return;
      }

      this.messages.push(...responseMessages);
      this.onPersist?.(this.messages.slice(turnStart));
      queue.push({ type: "message-finish", text, ...(totalUsage ? { totalUsage } : {}) });
    } catch (error) {
      this.messages.splice(turnStart);
      queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
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

  abort(): void {
    if (this.activeTurn) {
      this.activeTurn.aborted = true;
    }
    this.gate.abortAll();
    this.activeTurn?.abortController.abort();
  }
}
