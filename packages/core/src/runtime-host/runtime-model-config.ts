import { isDeepStrictEqual } from "node:util";
import type { RuntimeServiceOptions } from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { resolveReasoningPresentation } from "../llm/reasoning-presentation.ts";
import {
  resolveChatLlmReadiness,
  resolveChatLlmSwitch,
  type ConversationEngineInstance,
} from "./engine-factory.ts";

function startupSettings(config: RollConfig) {
  const { llm: _llm, runtime, ...rest } = config;
  const { provider: _provider, model: _model, thinkingLevel: _thinking, ...settings } = runtime;
  return { ...rest, runtime: settings };
}

export function createRuntimeModelConfig(
  config: RollConfig,
  initial: NonNullable<RuntimeServiceOptions["modelConfig"]>["initial"],
  read: () => RollConfig,
  engine: Pick<ConversationEngineInstance, "switchModel">,
): NonNullable<RuntimeServiceOptions["modelConfig"]> {
  const startup = startupSettings(config);
  return {
    initial,
    reload() {
      let selection: ReturnType<typeof resolveChatLlmSwitch>;
      try {
        const latest = read();
        if (!isDeepStrictEqual(startup, startupSettings(latest))) {
          return { status: "failed", reason: "restart-required" };
        }
        const choice = resolveChatLlmReadiness(latest);
        selection = resolveChatLlmSwitch(latest, choice, latest.runtime.thinkingLevel);
      } catch {
        // Loader and provider diagnostics can contain private configuration.
        return { status: "failed", reason: "invalid-config" };
      }
      const reasoning = resolveReasoningPresentation(selection.model, selection.providerOptions);
      engine.switchModel(selection);
      return {
        status: "applied",
        model: { provider: selection.provider, model: selection.modelName },
        ...(reasoning === undefined ? {} : { reasoning: reasoning.kind }),
      };
    },
  };
}
