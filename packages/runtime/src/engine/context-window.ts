import type { ModelCatalog } from "./model-catalog.ts";

interface ContextWindowEntry {
  readonly match: string;
  readonly window: number;
}

const MODEL_CONTEXT_WINDOWS: readonly ContextWindowEntry[] = [
  { match: "claude-fable-5", window: 1_000_000 },
  { match: "claude-mythos-5", window: 1_000_000 },
  { match: "claude-opus-4-8", window: 1_000_000 },
  { match: "claude-opus-4-7", window: 1_000_000 },
  { match: "claude-opus-4-6", window: 1_000_000 },
  { match: "claude-sonnet-5", window: 1_000_000 },
  { match: "claude-sonnet-4-6", window: 1_000_000 },
  { match: "claude-haiku-4-5", window: 200_000 },
  { match: "claude", window: 200_000 },
  { match: "gpt-5.5", window: 1_050_000 },
  { match: "gpt-5.4-mini", window: 400_000 },
  { match: "gpt-5.4-nano", window: 400_000 },
  { match: "gpt-5.4", window: 1_050_000 },
  { match: "gpt-5-mini", window: 400_000 },
  { match: "gpt-5-nano", window: 400_000 },
  { match: "gpt-5", window: 400_000 },
  { match: "gpt-4.1", window: 128_000 },
  { match: "gpt-4o", window: 128_000 },
  { match: "gpt-4-turbo", window: 128_000 },
  { match: "o3", window: 200_000 },
  { match: "o1-mini", window: 128_000 },
  { match: "o1", window: 200_000 },
  { match: "grok-4.6", window: 500_000 },
  { match: "grok-4.5", window: 500_000 },
  { match: "deepseek-v4", window: 1_000_000 },
  { match: "deepseek-chat", window: 1_000_000 },
  { match: "deepseek-reasoner", window: 1_000_000 },
  { match: "deepseek", window: 128_000 },
  { match: "qwen-long", window: 10_000_000 },
  { match: "qwen3-coder", window: 1_000_000 },
  { match: "qwen3.8-plus", window: 1_000_000 },
  { match: "qwen3.8-max", window: 1_000_000 },
  { match: "qwen3.7-plus", window: 1_000_000 },
  { match: "qwen3.7-max", window: 1_000_000 },
  { match: "qwen3.6-plus", window: 1_000_000 },
  { match: "qwen3.5-plus", window: 1_000_000 },
  { match: "qwen3.5-flash", window: 1_000_000 },
  { match: "qwen-plus", window: 1_000_000 },
  { match: "qwen-flash", window: 1_000_000 },
  { match: "qwen3-max", window: 262_144 },
  { match: "qwen3-vl-plus", window: 262_144 },
  { match: "qwen-vl-plus", window: 131_072 },
  { match: "qwen", window: 131_072 },
  { match: "gemini", window: 1_000_000 },
  { match: "kimi", window: 128_000 },
  { match: "glm", window: 128_000 },
];

export function lookupContextWindow(modelName: string): number | undefined {
  const normalized = modelName.toLowerCase();
  return MODEL_CONTEXT_WINDOWS.find((entry) => normalized.includes(entry.match))?.window;
}

export function resolveContextWindow(modelName: string, override?: number): number | undefined {
  if (override !== undefined) {
    return override;
  }
  return lookupContextWindow(modelName);
}

export const CONTEXT_WINDOW_SOURCES = {
  override: "override",
  catalog: "catalog",
  rule: "rule",
} as const;

export type ContextWindowSource =
  (typeof CONTEXT_WINDOW_SOURCES)[keyof typeof CONTEXT_WINDOW_SOURCES];

export interface ContextWindowResolution {
  readonly window: number;
  readonly source: ContextWindowSource;
}

export interface ResolveModelContextWindowInput {
  readonly provider: string;
  readonly model: string;
  readonly override?: number;
  readonly catalog?: ModelCatalog;
}

export function resolveModelContextWindow(
  input: ResolveModelContextWindowInput,
): ContextWindowResolution | undefined {
  if (input.override !== undefined) {
    return { window: input.override, source: CONTEXT_WINDOW_SOURCES.override };
  }
  const fromCatalog = input.catalog?.lookup(input.provider, input.model);
  if (fromCatalog !== undefined) {
    return { window: fromCatalog, source: CONTEXT_WINDOW_SOURCES.catalog };
  }
  const fromRule = lookupContextWindow(input.model);
  return fromRule === undefined
    ? undefined
    : { window: fromRule, source: CONTEXT_WINDOW_SOURCES.rule };
}
