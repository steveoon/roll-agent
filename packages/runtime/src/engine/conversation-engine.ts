import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { McpClientManager } from "@roll-agent/core/mcp/client-manager";
import { createProviderModel } from "@roll-agent/core/llm/providers";
import { AgentStore } from "@roll-agent/core/registry/store";
import { resolveTransportWithDevSpawnSpec } from "@roll-agent/core/registry/dev-spawn";
import { normalizeListedTools } from "@roll-agent/core/cli/utils/agent-tools";
import { getAgentEnv } from "@roll-agent/core/config/helpers";
import type { RollConfig } from "@roll-agent/core/config/schema";
import type { RegisteredAgent } from "@roll-agent/core/types/agent";
import type { AgentToolSource, SourceTool } from "../tool-bridge/build-tools.ts";
import type { ToolAnnotations, ToolPolicy } from "../types/policy.ts";
import type { ThreadStore } from "../store/thread-store.ts";
import { AgentSession } from "./agent-session.ts";

const DEFAULT_MAX_STEPS = 16;

export interface ConversationEngineOptions {
  readonly config: RollConfig;
  readonly agents?: readonly RegisteredAgent[];
  readonly model?: LanguageModelV3;
  readonly sources?: readonly AgentToolSource[];
  readonly clientManager?: McpClientManager;
  readonly store?: ThreadStore;
  readonly policy?: ToolPolicy;
  readonly maxSteps?: number;
  readonly onAgentBootstrapIssue?: (issue: AgentBootstrapIssue) => void;
}

export interface CreateSessionInput {
  readonly title?: string;
}

export interface AgentBootstrapIssue {
  readonly agentName: string;
  readonly message: string;
}

interface EngineContext {
  readonly model: LanguageModelV3;
  readonly sources: readonly AgentToolSource[];
}

function extractAnnotations(listed: unknown): ToolAnnotations | undefined {
  if (typeof listed !== "object" || listed === null || !("annotations" in listed)) {
    return undefined;
  }
  const annotations = (listed as { readonly annotations: unknown }).annotations;
  if (typeof annotations !== "object" || annotations === null) {
    return undefined;
  }
  const result: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
  if (
    "readOnlyHint" in annotations &&
    typeof (annotations as { readonly readOnlyHint: unknown }).readOnlyHint === "boolean"
  ) {
    result.readOnlyHint = (annotations as { readonly readOnlyHint: boolean }).readOnlyHint;
  }
  if (
    "destructiveHint" in annotations &&
    typeof (annotations as { readonly destructiveHint: unknown }).destructiveHint === "boolean"
  ) {
    result.destructiveHint = (annotations as { readonly destructiveHint: boolean }).destructiveHint;
  }
  return result.readOnlyHint === undefined && result.destructiveHint === undefined
    ? undefined
    : result;
}

export class ConversationEngine {
  private readonly config: RollConfig;
  private readonly clientManager: McpClientManager;
  private readonly store: ThreadStore | undefined;
  private readonly policy: ToolPolicy | undefined;
  private readonly maxSteps: number;
  private readonly explicitAgents: readonly RegisteredAgent[] | undefined;
  private readonly explicitModel: LanguageModelV3 | undefined;
  private readonly explicitSources: readonly AgentToolSource[] | undefined;
  private readonly onAgentBootstrapIssue: ((issue: AgentBootstrapIssue) => void) | undefined;
  private ready: Promise<EngineContext> | undefined;

  constructor(options: ConversationEngineOptions) {
    this.config = options.config;
    this.clientManager = options.clientManager ?? new McpClientManager();
    this.store = options.store;
    this.policy = options.policy;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.explicitAgents = options.agents;
    this.explicitModel = options.model;
    this.explicitSources = options.sources;
    this.onAgentBootstrapIssue = options.onAgentBootstrapIssue;
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const context = await this.ensureReady();
    const id = this.store
      ? this.store.createThread({
          ...(input.title ? { title: input.title } : {}),
          model: this.resolveModelName(),
        })
      : randomUUID();
    return this.buildSession(context, id, []);
  }

  async resumeSession(threadId: string): Promise<AgentSession> {
    if (!this.store) {
      throw new Error("resumeSession requires a ThreadStore");
    }
    if (!this.store.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const context = await this.ensureReady();
    return this.buildSession(context, threadId, this.store.getMessages(threadId));
  }

  private buildSession(
    context: EngineContext,
    id: string,
    initialMessages: readonly ModelMessage[],
  ): AgentSession {
    const store = this.store;
    return new AgentSession({
      id,
      model: context.model,
      sources: context.sources,
      maxSteps: this.maxSteps,
      ...(this.policy ? { policy: this.policy } : {}),
      initialMessages,
      ...(store ? { onPersist: (messages) => store.appendMessages(id, messages) } : {}),
    });
  }

  private ensureReady(): Promise<EngineContext> {
    if (!this.ready) {
      this.ready = this.bootstrap();
    }
    return this.ready;
  }

  private async bootstrap(): Promise<EngineContext> {
    const model = this.explicitModel ?? this.resolveModel();
    if (this.explicitSources) {
      return { model, sources: this.explicitSources };
    }
    const agents = this.explicitAgents ?? new AgentStore(this.config.agents.dataDir).list();
    const sources: AgentToolSource[] = [];

    for (const agent of agents) {
      try {
        const transport = resolveTransportWithDevSpawnSpec(agent);
        const env = getAgentEnv(this.config, agent.skill.name);
        const client = await this.clientManager.connect(
          agent.skill.name,
          transport,
          agent.installPath,
          { samplingModel: model, ...(env ? { env } : {}) },
        );
        const listed = (await client.listTools()).tools;
        const normalized = normalizeListedTools(listed);
        const sourceTools: SourceTool[] = normalized.map((agentTool, index) => ({
          tool: agentTool,
          annotations: extractAnnotations(listed[index]),
        }));
        sources.push({ agentName: agent.skill.name, client, tools: sourceTools });
      } catch (error) {
        this.onAgentBootstrapIssue?.({
          agentName: agent.skill.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { model, sources };
  }

  private resolveModel(): LanguageModelV3 {
    const provider = this.resolveProviderName();
    const modelName = this.resolveModelName();
    const providerConfig = this.config.llm.providers[provider];
    if (!providerConfig) {
      throw new Error(`LLM provider "${provider}" 未配置`);
    }
    return createProviderModel(provider, modelName, providerConfig.apiKey, providerConfig.baseUrl);
  }

  private resolveProviderName(): string {
    return this.config.runtime.provider ?? this.config.llm.defaultProvider;
  }

  private resolveModelName(): string {
    return this.config.runtime.model ?? this.config.llm.defaultModel;
  }

  async dispose(): Promise<void> {
    await this.clientManager.disconnectAll();
  }
}
