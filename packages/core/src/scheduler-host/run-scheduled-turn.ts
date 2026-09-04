import type { ChildProcess } from "node:child_process";
import type { RollConfig } from "../config/schema.ts";
import type { ChatCommandResult } from "../types/chat.ts";
import {
  CHAT_ENGINE_SURFACES,
  createChatEngine,
  createToolPolicy,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  type RuntimeModule,
} from "../runtime-host/engine-factory.ts";
import { runJsonTurn } from "../runtime-host/json-turn.ts";
import { computeAuthorityDigest, describeAuthorityDrift } from "./authority.ts";
import {
  SCHEDULED_TURN_STATUSES,
  type ScheduledTurnOutcome,
  type ScheduledTurnRunner,
} from "./execute-invocation.ts";

export interface CreateScheduledTurnRunnerInput {
  readonly config: RollConfig;
  readonly runtime: RuntimeModule;
  readonly shellEnv?: NodeJS.ProcessEnv;
  readonly stopSignal?: AbortSignal;
  readonly onShellCommandSpawn?: (child: ChildProcess) => void;
}

function mapTurnResult(result: ChatCommandResult, denied: readonly string[]): ScheduledTurnOutcome {
  switch (result.status) {
    case "completed":
      return denied.length > 0
        ? {
            status: SCHEDULED_TURN_STATUSES.needsConfirmation,
            threadId: result.sessionId,
            output: result.output,
            pendingActions: denied,
          }
        : {
            status: SCHEDULED_TURN_STATUSES.completed,
            threadId: result.sessionId,
            output: result.output,
          };
    case "needs_confirmation":
      return {
        status: SCHEDULED_TURN_STATUSES.needsConfirmation,
        threadId: result.sessionId,
        output: "",
        pendingActions: [...result.pendingActions.map((action) => action.summary), ...denied],
      };
    case "needs_input":
      return {
        status: SCHEDULED_TURN_STATUSES.failed,
        threadId: result.sessionId,
        error: "需要用户输入",
      };
    case "failed":
      return {
        status: SCHEDULED_TURN_STATUSES.failed,
        ...(result.sessionId !== undefined ? { threadId: result.sessionId } : {}),
        error: result.message,
      };
    case "unavailable":
      return { status: SCHEDULED_TURN_STATUSES.failed, error: result.message };
  }
}

export function createScheduledTurnRunner(
  input: CreateScheduledTurnRunnerInput,
): ScheduledTurnRunner {
  return async (schedule, invocation) => {
    if (input.stopSignal?.aborted === true) {
      return { status: SCHEDULED_TURN_STATUSES.failed, error: "本轮执行已收到停止请求" };
    }
    const currentAuthority = computeAuthorityDigest(input.config);
    if (schedule.authorityDigest !== currentAuthority) {
      return {
        status: SCHEDULED_TURN_STATUSES.failed,
        error: describeAuthorityDrift(schedule.id, schedule.authorityDigest, currentAuthority),
        terminal: true,
      };
    }
    const readiness = resolveChatLlmReadiness(input.config);
    if (!readiness.configured || !readiness.providerConfig) {
      return { status: SCHEDULED_TURN_STATUSES.failed, error: readiness.message };
    }
    const llm = resolveChatLlmCalls(
      readiness.provider,
      readiness.model,
      readiness.providerConfig.apiKey,
      readiness.providerConfig.baseUrl,
      input.config.runtime.thinkingLevel,
      input.config.runtime.compaction.thinkingLevel,
      input.config.runtime.compaction.strategy === "summarize",
    );
    const store = new input.runtime.ThreadStore(input.config.runtime.threadsDir);
    const policy = new input.runtime.UnattendedToolPolicy(
      createToolPolicy(input.runtime, input.config),
    );
    const engine = createChatEngine({
      runtime: input.runtime,
      config: input.config,
      model: llm.model,
      store,
      surface: CHAT_ENGINE_SURFACES.background,
      policy,
      modelCatalog: input.runtime.createDefaultModelCatalog(
        input.runtime.defaultModelCatalogCachePath(),
      ),
      resolveDynamicCapabilityContext: () => ({
        origin: {
          kind: "scheduled",
          scheduleId: schedule.id,
          invocationId: invocation.id,
          scheduledFor: new Date(invocation.scheduledForMs).toISOString(),
          unattended: true,
        },
      }),
      ...(llm.providerOptions ? { providerOptions: llm.providerOptions } : {}),
      ...(llm.structuredOutputProviderOptions
        ? { structuredOutputProviderOptions: llm.structuredOutputProviderOptions }
        : {}),
      ...(llm.structuredOutputReasoning
        ? { structuredOutputReasoning: llm.structuredOutputReasoning }
        : {}),
      ...(input.shellEnv ? { shellEnv: input.shellEnv } : {}),
      ...(input.onShellCommandSpawn ? { onShellCommandSpawn: input.onShellCommandSpawn } : {}),
    });
    let session: Awaited<ReturnType<typeof engine.createSession>> | undefined;
    try {
      session = await engine.createSession({ title: `[定时] ${schedule.name}` });
      const result = await runJsonTurn(session, schedule.prompt, input.stopSignal);
      const denied = policy.deniedConfirmations.map((item) => `${item.agentName}.${item.toolName}`);
      return mapTurnResult(result, denied);
    } finally {
      await session?.close();
      await engine.dispose();
      store.close();
    }
  };
}
