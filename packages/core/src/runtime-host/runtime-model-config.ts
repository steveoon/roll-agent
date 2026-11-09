import { isDeepStrictEqual } from "node:util";
import type {
  RuntimeServiceOptions,
  ConversationEngine,
  ThreadModelEngine,
} from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { resolveReasoningPresentation } from "../llm/reasoning-presentation.ts";
import { createThreadModelHost } from "./thread-model-host.ts";
import { resolveChatLlmReadiness, resolveChatLlmSwitch } from "./engine-factory.ts";

function startupSettings(config: RollConfig) {
  const { llm: _llm, runtime, ...rest } = config;
  const { provider: _provider, model: _model, thinkingLevel: _thinking, ...settings } = runtime;
  return { ...rest, runtime: settings };
}

export function modelConfigRequiresRestart(startup: RollConfig, latest: RollConfig): boolean {
  return !isDeepStrictEqual(startupSettings(startup), startupSettings(latest));
}

export function createRuntimeModelConfig(
  config: RollConfig,
  initial: NonNullable<RuntimeServiceOptions["modelConfig"]>["initial"],
  read: () => RollConfig,
  engine: Pick<ConversationEngine, "switchModel"> | Pick<ThreadModelEngine, "reloadModelHost">,
): NonNullable<RuntimeServiceOptions["modelConfig"]> {
  return {
    initial,
    reload() {
      let selection: ReturnType<typeof resolveChatLlmSwitch>;
      let latest: RollConfig;
      try {
        latest = read();
        if (modelConfigRequiresRestart(config, latest)) {
          return { status: "failed", reason: "restart-required" };
        }
        const choice = resolveChatLlmReadiness(latest);
        selection = resolveChatLlmSwitch(latest, choice, latest.runtime.thinkingLevel);
      } catch {
        // Loader and provider diagnostics can contain private configuration.
        return { status: "failed", reason: "invalid-config" };
      }
      const reasoning = resolveReasoningPresentation(selection.model, selection.providerOptions);
      const prepared = { ...selection, ...(reasoning ? { reasoning: reasoning.kind } : {}) };
      const result = {
        status: "applied",
        model: { provider: selection.provider, model: selection.modelName },
        ...(reasoning === undefined ? {} : { reasoning: reasoning.kind }),
      } as const;
      if ("reloadModelHost" in engine) {
        return engine
          .reloadModelHost(createThreadModelHost(latest, prepared), prepared)
          .then(() => result);
      }
      engine.switchModel(selection);
      return result;
    },
  };
}
