import { randomUUID } from "node:crypto";
import { runtimeModelCatalogSchema, type RuntimeModelCatalog } from "@roll-agent/protocol";
import type { EngineModelSwitch, PreparedThreadModel, ThreadModelHost } from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { inspectLlmConfigReadiness } from "../config/helpers.ts";
import { resolveReasoningPresentation } from "../llm/reasoning-presentation.ts";
import { resolveChatLlmSwitch } from "./chat-model-resolution.ts";

export function withThreadModelReasoning(input: EngineModelSwitch): PreparedThreadModel {
  const reasoning = resolveReasoningPresentation(input.model, input.providerOptions);
  return {
    provider: input.provider,
    modelName: input.modelName,
    model: input.model,
    ...(input.toolSchemaPolicy ? { toolSchemaPolicy: input.toolSchemaPolicy } : {}),
    ...(input.modelRecovery ? { modelRecovery: input.modelRecovery } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    ...(input.structuredOutputProviderOptions
      ? { structuredOutputProviderOptions: input.structuredOutputProviderOptions }
      : {}),
    ...(input.structuredOutputReasoning
      ? { structuredOutputReasoning: input.structuredOutputReasoning }
      : {}),
    ...(reasoning ? { reasoning: reasoning.kind } : {}),
  };
}

export function createThreadModelHost(
  config: RollConfig,
  initial: PreparedThreadModel,
): ThreadModelHost {
  const configRevision = randomUUID();
  const defaultModel = { provider: initial.provider, model: initial.modelName };
  const identities = new Map<string, RuntimeModelCatalog["defaultModel"]>();
  for (const [provider, entry] of Object.entries(config.llm.providers)) {
    for (const model of entry.models ?? []) {
      identities.set(JSON.stringify([provider, model]), { provider, model });
    }
  }
  identities.set(JSON.stringify([defaultModel.provider, defaultModel.model]), defaultModel);
  const catalog = runtimeModelCatalogSchema.parse({
    configRevision,
    defaultModel,
    items: [...identities.values()].map((identity) => {
      const subscription = identity.provider === "chatgpt";
      const available = subscription
        ? identity.provider === initial.provider && identity.model === initial.modelName
        : inspectLlmConfigReadiness(config, identity).configured;
      return {
        ...identity,
        available,
        ...(available
          ? {}
          : { reason: subscription ? "unsupported-provider" : "unconfigured-provider" }),
      };
    }),
  });
  return {
    catalog: () => catalog,
    async prepare(identity, signal) {
      signal.throwIfAborted();
      if (
        !catalog.items.some(
          (item) =>
            item.available && item.provider === identity.provider && item.model === identity.model,
        )
      ) {
        throw new Error("Configured model is unavailable");
      }
      if (identity.provider === initial.provider && identity.model === initial.modelName) {
        return initial;
      }
      const selection = resolveChatLlmSwitch(config, identity, config.runtime.thinkingLevel);
      signal.throwIfAborted();
      return withThreadModelReasoning(selection);
    },
  };
}
