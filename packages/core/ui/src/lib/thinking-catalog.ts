import { chatGptThinkingLevels, legacyThinkingLevels } from "../../../src/llm/thinking-levels.ts";
import type { ConfigCatalogNode, ConfigEnumOptionsStatus, JsonObject } from "../types.ts";
import { getAtPath } from "./config-value.ts";
import { validateEnumInput } from "./input-validation.ts";
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

function selectedCapability(draft: JsonObject, catalog: ChatGptModelCatalog) {
  const accountId = getAtPath(draft, ["runtime", "chatgptAccountId"]);
  const matchesAccount = accountId === undefined || accountId === catalog.accountId;
  return {
    provider: getAtPath(draft, ["runtime", "provider"]),
    model: matchesAccount
      ? catalog.models.find(({ slug }) => slug === getAtPath(draft, ["runtime", "model"]))
      : undefined,
    status: matchesAccount ? catalog.status : ("loading" as const),
  };
}

export function thinkingCatalogForDraft(
  node: ConfigCatalogNode,
  draft: JsonObject,
  catalog: ChatGptModelCatalog,
): ConfigCatalogNode {
  const { provider, model, status } = selectedCapability(draft, catalog);
  return thinkingCatalog(node, provider, model, status);
}

/** Validate even hidden modules, so model/catalog changes cannot leave stale field issues. */
export function thinkingFieldValidity(draft: JsonObject, catalog: ChatGptModelCatalog) {
  const { provider, model, status } = selectedCapability(draft, catalog);
  const options = provider === "chatgpt" ? chatGptThinkingLevels(model) : legacyThinkingLevels;
  return THINKING_PATHS.map((path) => ({
    path,
    message: validateEnumInput(getAtPath(draft, path), {
      options,
      optionsStatus: provider === "chatgpt" ? status : "ready",
    }),
  }));
}

/** Presentation only: never changes saved values or the authoritative schema. */
export function thinkingCatalog(
  node: ConfigCatalogNode,
  provider: unknown,
  model?: { readonly reasoningEfforts?: readonly string[] | undefined },
  status: ConfigEnumOptionsStatus = "ready",
): ConfigCatalogNode {
  if (node.kind === "object") {
    return {
      ...node,
      fields: Object.fromEntries(
        Object.entries(node.fields).map(([key, child]) => [
          key,
          thinkingCatalog(child, provider, model, status),
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
  const options = provider === "chatgpt" ? chatGptThinkingLevels(model) : legacyThinkingLevels;
  return {
    ...node,
    options,
    optionsStatus: provider === "chatgpt" ? status : "ready",
    description: `${node.description ?? ""} 当前可选：${options.join(" / ") || "无"}。xhigh/max 使用模型原生强度，可能增加延迟和用量。`,
  };
}
