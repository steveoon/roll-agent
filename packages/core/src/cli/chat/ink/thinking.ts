import type { ThinkingLevel } from "../../../llm/providers.ts";

const LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

export function cycleThinking(level: ThinkingLevel, direction: 1 | -1): ThinkingLevel {
  const index = LEVELS.indexOf(level);
  const next = Math.min(Math.max(index + direction, 0), LEVELS.length - 1);
  return LEVELS[next] ?? level;
}

export function thinkingLabel(level: ThinkingLevel): string {
  return `🧠 ${level}`;
}
