import type { RollConfig } from "../config/schema.ts";
import {
  DEFAULT_LLM_MODELS,
  LLM_PROVIDER_OPTIONS,
  type LlmProviderOption,
} from "../config/defaults.ts";

export const LLM_MODEL_CHOICE_ORIGINS = {
  default: "default",
  configured: "configured",
  builtin: "builtin",
} as const;

export type LlmModelChoiceOrigin =
  (typeof LLM_MODEL_CHOICE_ORIGINS)[keyof typeof LLM_MODEL_CHOICE_ORIGINS];

export interface LlmModelChoice {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly origin: LlmModelChoiceOrigin;
}

function isLlmProviderOption(value: string): value is LlmProviderOption {
  return LLM_PROVIDER_OPTIONS.some((candidate) => candidate === value);
}

function choice(provider: string, model: string, origin: LlmModelChoiceOrigin): LlmModelChoice {
  return { id: `${provider}/${model}`, provider, model, origin };
}

export function listLlmModelChoices(config: RollConfig): readonly LlmModelChoice[] {
  const defaultProvider = config.runtime.provider ?? config.llm.defaultProvider;
  const defaultModel = config.runtime.model ?? config.llm.defaultModel;
  const choices: LlmModelChoice[] = [];
  const seen = new Set<string>();
  const push = (next: LlmModelChoice): void => {
    if (!seen.has(next.id)) {
      seen.add(next.id);
      choices.push(next);
    }
  };

  const defaultProviderConfig = config.llm.providers[defaultProvider];
  if (defaultProviderConfig && defaultProviderConfig.apiKey.trim().length > 0) {
    push(choice(defaultProvider, defaultModel, LLM_MODEL_CHOICE_ORIGINS.default));
  }

  for (const [provider, providerConfig] of Object.entries(config.llm.providers)) {
    if (providerConfig.apiKey.trim().length === 0) {
      continue;
    }
    const configured = providerConfig.models ?? [];
    for (const model of configured) {
      push(choice(provider, model, LLM_MODEL_CHOICE_ORIGINS.configured));
    }
    if (configured.length === 0 && provider !== defaultProvider && isLlmProviderOption(provider)) {
      push(choice(provider, DEFAULT_LLM_MODELS[provider], LLM_MODEL_CHOICE_ORIGINS.builtin));
    }
  }
  return choices;
}

export function findLlmModelChoice(
  choices: readonly LlmModelChoice[],
  input: string,
): LlmModelChoice | undefined {
  const needle = input.trim();
  if (needle.length === 0) {
    return undefined;
  }
  const exact = choices.find((candidate) => candidate.id === needle);
  if (exact) {
    return exact;
  }
  const byModel = choices.filter((candidate) => candidate.model === needle);
  return byModel.length === 1 ? byModel[0] : undefined;
}
