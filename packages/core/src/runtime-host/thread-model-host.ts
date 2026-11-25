import { randomUUID } from "node:crypto";
import {
  runtimeModelCatalogSchema,
  type RuntimeModelCatalog,
  type ThreadEffortCapability,
  type ThreadEffortLevel,
} from "@roll-agent/protocol";
import {
  ThreadModelError,
  type EngineModelSwitch,
  type PreparedThreadEffort,
  type PreparedThreadModel,
  type ThreadModelHost,
} from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { inspectLlmConfigReadiness } from "../config/helpers.ts";
import {
  isExplicitThreadEffortSupported,
  resolveChatOrSamplingProviderOptions,
  resolveDefaultThreadEffort,
  resolveThreadEffortCapability,
  UnsupportedThinkingLevelError,
  validateStructuredOutputThinkingLevel,
} from "../llm/providers.ts";
import { resolveReasoningPresentation } from "../llm/reasoning-presentation.ts";
import { resolveChatLlmSwitch } from "./chat-model-resolution.ts";

export function withThreadModelReasoning(
  input: EngineModelSwitch,
  effortMetadata?: {
    readonly effort: ThreadEffortLevel;
    readonly effortCapability: ThreadEffortCapability;
  },
): PreparedThreadModel {
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
    ...(effortMetadata
      ? {
          effort: effortMetadata.effort,
          effortCapability: effortMetadata.effortCapability,
        }
      : {}),
  };
}

function assertCompactionEffortCompatible(
  config: RollConfig,
  identity: RuntimeModelCatalog["defaultModel"],
  effectiveEffort: ThreadEffortLevel,
): void {
  if (config.runtime.compaction.strategy !== "summarize") {
    return;
  }
  const explicitCompactionEffort = config.runtime.compaction.thinkingLevel;
  const compactionEffort = explicitCompactionEffort ?? effectiveEffort;
  try {
    validateStructuredOutputThinkingLevel(identity.provider, identity.model, compactionEffort);
  } catch (error) {
    if (explicitCompactionEffort !== undefined) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = detail.includes("runtime.compaction.thinking-level")
        ? `压缩配置冲突：${detail}`
        : `压缩配置 runtime.compaction.thinking-level 不兼容：${detail}`;
      throw new ThreadModelError("compaction-effort-incompatible", message);
    }
    throw new ThreadModelError(
      "effort-unsupported",
      error instanceof Error ? error.message : undefined,
    );
  }
}

export function createThreadModelHost(
  config: RollConfig,
  initial: PreparedThreadModel,
): ThreadModelHost {
  const configRevision = randomUUID();
  const initialEffort = initial.effort ?? config.runtime.thinkingLevel;
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
    defaultEffort: config.runtime.thinkingLevel,
    items: [...identities.values()].map((identity) => {
      const subscription = identity.provider === "chatgpt";
      const available = subscription
        ? identity.provider === initial.provider && identity.model === initial.modelName
        : inspectLlmConfigReadiness(config, identity).configured;
      const effortCapability: ThreadEffortCapability = subscription
        ? { kind: "unknown" }
        : resolveThreadEffortCapability(identity.provider, identity.model);
      return {
        ...identity,
        available,
        effortCapability,
        ...(available
          ? {}
          : { reason: subscription ? "unsupported-provider" : "unconfigured-provider" }),
      };
    }),
  });
  function defaultEffortFor(item: RuntimeModelCatalog["items"][number]): ThreadEffortLevel {
    if (
      item.effortCapability.kind === "unknown" &&
      item.provider === initial.provider &&
      item.model === initial.modelName
    ) {
      return initialEffort;
    }
    return resolveDefaultThreadEffort(
      item.effortCapability,
      item.provider,
      item.model,
      config.runtime.thinkingLevel,
      config.llm.providers[item.provider]?.baseUrl,
    );
  }
  return {
    catalog: () => catalog,
    validate({ identity, effort, requiresFullModelPrepare }) {
      const item = catalog.items.find(
        (candidate) =>
          candidate.provider === identity.provider && candidate.model === identity.model,
      );
      if (!item?.available) {
        throw new ThreadModelError("model-unavailable");
      }
      const effectiveEffort = effort.mode === "explicit" ? effort.level : defaultEffortFor(item);
      if (effort.mode === "explicit") {
        if (
          !isExplicitThreadEffortSupported(
            item.effortCapability,
            identity.provider,
            identity.model,
            effectiveEffort,
          )
        ) {
          throw new ThreadModelError(
            "effort-unsupported",
            `模型 ${identity.provider}/${identity.model} 不支持推理强度 "${effectiveEffort}"`,
          );
        }
      } else if (
        item.effortCapability.kind === "levels" &&
        !item.effortCapability.levels.includes(effectiveEffort)
      ) {
        throw new ThreadModelError(
          "effort-unsupported",
          `模型 ${identity.provider}/${identity.model} 不支持默认推理强度 "${effectiveEffort}"`,
        );
      } else if (
        item.effortCapability.kind === "toggle" &&
        !isExplicitThreadEffortSupported(
          item.effortCapability,
          identity.provider,
          identity.model,
          effectiveEffort,
        )
      ) {
        throw new ThreadModelError(
          "effort-unsupported",
          `模型 ${identity.provider}/${identity.model} 不支持默认推理强度 "${effectiveEffort}"`,
        );
      }
      const isUnchangedUnknownInitial =
        item.effortCapability.kind === "unknown" &&
        identity.provider === initial.provider &&
        identity.model === initial.modelName &&
        effectiveEffort === initialEffort;
      if (!isUnchangedUnknownInitial) {
        const providerConfig = config.llm.providers[identity.provider];
        try {
          resolveChatOrSamplingProviderOptions(
            identity.provider,
            identity.model,
            providerConfig?.baseUrl,
            effectiveEffort,
          );
        } catch (error) {
          throw new ThreadModelError(
            "effort-unsupported",
            error instanceof UnsupportedThinkingLevelError || error instanceof Error
              ? error.message
              : undefined,
          );
        }
        if (requiresFullModelPrepare) {
          assertCompactionEffortCompatible(config, identity, effectiveEffort);
        }
      }
      return {
        provider: identity.provider,
        model: identity.model,
        effectiveEffort,
        effortCapability: item.effortCapability,
      };
    },
    prepareEffort(current, effectiveEffort): PreparedThreadEffort {
      const providerConfig = config.llm.providers[current.provider];
      const providerOptions = resolveChatOrSamplingProviderOptions(
        current.provider,
        current.modelName,
        providerConfig?.baseUrl,
        effectiveEffort,
      );
      const reasoning = resolveReasoningPresentation(current.model, providerOptions);
      return {
        effort: effectiveEffort,
        effortCapability: resolveThreadEffortCapability(current.provider, current.modelName),
        ...(providerOptions ? { providerOptions } : {}),
        ...(reasoning ? { reasoning: reasoning.kind } : {}),
      };
    },
    async prepare(identity, signal, effort) {
      signal.throwIfAborted();
      const item = catalog.items.find(
        (candidate) =>
          candidate.available &&
          candidate.provider === identity.provider &&
          candidate.model === identity.model,
      );
      if (!item) {
        throw new Error("Configured model is unavailable");
      }
      const effectiveEffort = effort ?? defaultEffortFor(item);
      if (
        identity.provider === initial.provider &&
        identity.model === initial.modelName &&
        effectiveEffort === initialEffort
      ) {
        return initial;
      }
      const selection = resolveChatLlmSwitch(config, identity, effectiveEffort);
      signal.throwIfAborted();
      return withThreadModelReasoning(selection, {
        effort: effectiveEffort,
        effortCapability: item.effortCapability,
      });
    },
  };
}
