interface ContextWindowEntry {
  readonly match: string;
  readonly window: number;
}

const MODEL_CONTEXT_WINDOWS: readonly ContextWindowEntry[] = [
  { match: "claude", window: 200_000 },
  { match: "gpt-5", window: 128_000 },
  { match: "gpt-4.1", window: 128_000 },
  { match: "gpt-4o", window: 128_000 },
  { match: "gpt-4-turbo", window: 128_000 },
  { match: "o3", window: 200_000 },
  { match: "o1", window: 200_000 },
  { match: "deepseek", window: 128_000 },
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
