import {
  hasUnresolvedEnvPlaceholder,
  hasUnresolvedThinkingIdentity,
} from "../../../src/config/helpers.ts";
import {
  apiThinkingLevels,
  chatGptThinkingLevels,
  legacyThinkingLevels,
  runtimeThinkingLevels,
} from "../../../src/llm/thinking-levels.ts";
import type { ConfigCatalogNode, ConfigEnumOptionsStatus, JsonObject } from "../types.ts";
import { getAtPath } from "./config-value.ts";
import { isEnvironmentReferenceDraft, validateEnumInput } from "./input-validation.ts";
import type { RollUiApi } from "../api.ts";

export interface ChatGptModelCatalog {
  readonly accountId?: string;
  readonly models: Awaited<ReturnType<RollUiApi["getChatGptModels"]>>;
  readonly status: ConfigEnumOptionsStatus;
}

const THINKING_PATHS = [
  ["runtime", "thinkingLevel"],
  ["runtime", "compaction", "thinkingLevel"],
] as const;

function isUnresolvedDraftPlaceholder(value: string): boolean {
  return hasUnresolvedEnvPlaceholder(value) || isEnvironmentReferenceDraft(value);
}

function selectedCapability(draft: JsonObject, catalog: ChatGptModelCatalog) {
  const provider =
    getAtPath(draft, ["runtime", "provider"]) ?? getAtPath(draft, ["llm", "defaultProvider"]);
  const accountId = getAtPath(draft, ["runtime", "chatgptAccountId"]);
  const runtimeModel = getAtPath(draft, ["runtime", "model"]);
  const effectiveModel =
    provider === "chatgpt"
      ? runtimeModel
      : (runtimeModel ?? getAtPath(draft, ["llm", "defaultModel"]));
  const matchesAccount = accountId === undefined || accountId === catalog.accountId;
  const model = matchesAccount
    ? catalog.models.find(({ slug }) => slug === runtimeModel)
    : undefined;
  const unresolved = hasUnresolvedThinkingIdentity(
    { provider, model: effectiveModel, chatgptAccountId: accountId },
    isUnresolvedDraftPlaceholder,
  );
  let status: ConfigEnumOptionsStatus = provider === "chatgpt" ? catalog.status : "ready";
  if (provider === "chatgpt" && !matchesAccount) status = "loading";
  if (
    unresolved ||
    (provider === "chatgpt" && status === "ready" && model?.reasoningEfforts === undefined)
  ) {
    status = "unavailable";
  }
  return {
    provider,
    modelName: typeof effectiveModel === "string" ? effectiveModel : undefined,
    model,
    status,
  };
}

export function thinkingCatalogForDraft(
  node: ConfigCatalogNode,
  draft: JsonObject,
  catalog: ChatGptModelCatalog,
): ConfigCatalogNode {
  const { provider, modelName, model, status } = selectedCapability(draft, catalog);
  return thinkingCatalog(node, provider, model, status, modelName);
}

/** Validate even hidden modules, so model/catalog changes cannot leave stale field issues. */
export function thinkingFieldValidity(draft: JsonObject, catalog: ChatGptModelCatalog) {
  const { provider, modelName, model, status } = selectedCapability(draft, catalog);
  const options =
    provider === "chatgpt"
      ? chatGptThinkingLevels(model)
      : typeof provider === "string"
        ? apiThinkingLevels(provider, modelName)
        : legacyThinkingLevels;
  return THINKING_PATHS.map((path) => ({
    path,
    message: validateEnumInput(getAtPath(draft, path), {
      options,
      optionsStatus: status,
    }),
  }));
}

/** Presentation only: never changes saved values or the authoritative schema. */
export function thinkingCatalog(
  node: ConfigCatalogNode,
  provider: unknown,
  model?: { readonly reasoningEfforts?: readonly string[] | undefined },
  status: ConfigEnumOptionsStatus = "ready",
  modelName?: string,
): ConfigCatalogNode {
  if (node.kind === "object") {
    return {
      ...node,
      fields: Object.fromEntries(
        Object.entries(node.fields).map(([key, child]) => [
          key,
          thinkingCatalog(child, provider, model, status, modelName),
        ]),
      ),
    };
  }
  if (
    node.kind !== "enum" ||
    !["runtime.thinkingLevel", "runtime.compaction.thinkingLevel"].includes(node.path.join("."))
  ) {
    return node;
  }
  const optionsStatus =
    provider === "chatgpt" && model?.reasoningEfforts === undefined && status === "ready"
      ? "unavailable"
      : status;
  const options =
    optionsStatus !== "ready"
      ? runtimeThinkingLevels
      : provider === "chatgpt"
        ? chatGptThinkingLevels(model)
        : typeof provider === "string"
          ? apiThinkingLevels(provider, modelName)
          : legacyThinkingLevels;
  return {
    ...node,
    options,
    optionsStatus,
    description: `${node.description ?? ""} ${optionsStatus === "ready" ? `当前可选：${options.join(" / ") || "无"}` : "配置或模型能力尚未解析，支持情况待验证"}。xhigh/max 使用模型原生强度，可能增加延迟和用量。`,
  };
}
