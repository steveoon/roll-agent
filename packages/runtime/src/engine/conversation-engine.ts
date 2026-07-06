import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import { McpClientManager } from "@roll-agent/core/mcp/client-manager";
import { createProviderModel } from "@roll-agent/core/llm/providers";
import { AgentStore } from "@roll-agent/core/registry/store";
import { resolveTransportWithDevSpawnSpec } from "@roll-agent/core/registry/dev-spawn";
import {
  getAgentPid,
  startAgent,
  waitForAgentReady,
} from "@roll-agent/core/registry/process-manager";
import { normalizeListedTools } from "@roll-agent/core/cli/utils/agent-tools";
import { getAgentEnv } from "@roll-agent/core/config/helpers";
import type { RollConfig } from "@roll-agent/core/config/schema";
import type { RegisteredAgent } from "@roll-agent/core/types/agent";
import { createSkillLibrary, type SkillLibrary } from "@roll-agent/core/skills/library";
import type { AgentToolSource, SourceTool } from "../tool-bridge/build-tools.ts";
import type { ToolAnnotations, ToolPolicy } from "../types/policy.ts";
import type { ThreadStore } from "../store/thread-store.ts";
import { AgentSession } from "./agent-session.ts";
import { resolveContextWindow } from "./context-window.ts";
import { buildChatSystemPrompt } from "./system-prompt.ts";

const DEFAULT_MAX_STEPS = 80;

export type EnsureAgentReady = (
  agent: RegisteredAgent,
  env: Readonly<Record<string, string>> | undefined,
) => Promise<void>;

export interface ConversationEngineOptions {
  readonly config: RollConfig;
  readonly agents?: readonly RegisteredAgent[];
  readonly model?: LanguageModelV4;
  readonly sources?: readonly AgentToolSource[];
  readonly clientManager?: McpClientManager;
  readonly store?: ThreadStore;
  readonly policy?: ToolPolicy;
  readonly maxSteps?: number;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly ensureAgentReady?: EnsureAgentReady;
  readonly debugEvents?: boolean;
  readonly onAgentBootstrapIssue?: (issue: AgentBootstrapIssue) => void;
  readonly skillLibrary?: SkillLibrary | null;
  readonly onSkillLibraryIssue?: (message: string) => void;
}

export interface CreateSessionInput {
  readonly title?: string;
}

export interface AgentBootstrapIssue {
  readonly agentName: string;
  readonly message: string;
}

export interface EngineContextSummary {
  readonly agentCount: number;
  readonly toolCount: number;
  readonly skillCount: number;
}

interface EngineContext {
  readonly model: LanguageModelV4;
  readonly sources: readonly AgentToolSource[];
  readonly skillLibrary?: SkillLibrary;
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

async function ensureCoreManagedAgentReady(
  agent: RegisteredAgent,
  dataDir: string,
  env: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  if (agent.runtime.ownership !== "core-managed") {
    return;
  }

  if (getAgentPid(dataDir, agent.skill.name) === undefined) {
    startAgent(agent, dataDir, env);
  }
  await waitForAgentReady(agent);
}

export class ConversationEngine {
  private readonly config: RollConfig;
  private readonly clientManager: McpClientManager;
  private readonly store: ThreadStore | undefined;
  private readonly policy: ToolPolicy | undefined;
  private readonly maxSteps: number;
  private readonly providerOptions: SharedV4ProviderOptions | undefined;
  private readonly ensureAgentReady: EnsureAgentReady;
  private readonly debugEvents: boolean;
  private readonly explicitAgents: readonly RegisteredAgent[] | undefined;
  private readonly explicitModel: LanguageModelV4 | undefined;
  private readonly explicitSources: readonly AgentToolSource[] | undefined;
  private readonly explicitSkillLibrary: SkillLibrary | null | undefined;
  private readonly onSkillLibraryIssue: ((message: string) => void) | undefined;
  private readonly onAgentBootstrapIssue: ((issue: AgentBootstrapIssue) => void) | undefined;
  private ready: Promise<EngineContext> | undefined;

  constructor(options: ConversationEngineOptions) {
    this.config = options.config;
    this.clientManager = options.clientManager ?? new McpClientManager();
    this.store = options.store;
    this.policy = options.policy;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.providerOptions = options.providerOptions;
    this.ensureAgentReady =
      options.ensureAgentReady ??
      ((agent, env) => ensureCoreManagedAgentReady(agent, this.config.agents.dataDir, env));
    this.debugEvents = options.debugEvents ?? false;
    this.explicitAgents = options.agents;
    this.explicitModel = options.model;
    this.explicitSources = options.sources;
    this.explicitSkillLibrary = options.skillLibrary;
    this.onSkillLibraryIssue = options.onSkillLibraryIssue;
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
    const contextWindow = resolveContextWindow(
      this.resolveModelName(),
      this.config.runtime.contextWindow,
    );
    const skills = context.skillLibrary?.list() ?? [];
    const skillLibrary = skills.length > 0 ? context.skillLibrary : undefined;
    const systemPrompt = buildChatSystemPrompt({ skills });
    return new AgentSession({
      id,
      model: context.model,
      sources: context.sources,
      systemPrompt,
      ...(skillLibrary ? { skillLibrary } : {}),
      maxSteps: this.maxSteps,
      compaction: this.config.runtime.compaction,
      turnTimeoutMs: this.config.runtime.turnTimeoutMs,
      debugEvents: this.debugEvents,
      ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(this.policy ? { policy: this.policy } : {}),
      initialMessages,
      ...(store
        ? {
            onPersist: (messages) => store.appendMessages(id, messages),
            onReplace: (messages) => store.replaceMessages(id, messages),
          }
        : {}),
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
      return {
        model,
        sources: this.explicitSources,
        ...(this.explicitSkillLibrary ? { skillLibrary: this.explicitSkillLibrary } : {}),
      };
    }
    const agents = this.explicitAgents ?? new AgentStore(this.config.agents.dataDir).list();
    const sources: AgentToolSource[] = [];

    for (const agent of agents) {
      try {
        const transport = resolveTransportWithDevSpawnSpec(agent);
        const env = getAgentEnv(this.config, agent.skill.name);
        await this.ensureAgentReady(agent, env);
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

    const skillLibrary = this.resolveSkillLibrary(agents);
    return { model, sources, ...(skillLibrary ? { skillLibrary } : {}) };
  }

  private resolveSkillLibrary(agents: readonly RegisteredAgent[]): SkillLibrary | undefined {
    if (this.explicitSkillLibrary === null) {
      return undefined;
    }
    if (this.explicitSkillLibrary !== undefined) {
      return this.explicitSkillLibrary;
    }
    return createSkillLibrary({
      agents,
      extraDirs: this.config.skills.dirs,
      ...(this.onSkillLibraryIssue ? { onIssue: this.onSkillLibraryIssue } : {}),
    });
  }

  private resolveModel(): LanguageModelV4 {
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

  async getContextSummary(): Promise<EngineContextSummary> {
    const context = await this.ensureReady();
    return {
      agentCount: context.sources.length,
      toolCount: context.sources.reduce((total, source) => total + source.tools.length, 0),
      skillCount: context.skillLibrary?.list().length ?? 0,
    };
  }

  async dispose(): Promise<void> {
    await this.clientManager.disconnectAll();
  }
}
