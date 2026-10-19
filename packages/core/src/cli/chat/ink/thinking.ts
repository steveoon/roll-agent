import type { ThinkingLevel } from "../../../llm/providers.ts";
import { GLYPHS } from "../../utils/glyphs.ts";

import { legacyThinkingLevels } from "../../../llm/thinking-levels.ts";

export function cycleThinking(
  level: ThinkingLevel,
  direction: 1 | -1,
  levels: readonly ThinkingLevel[] = legacyThinkingLevels,
): ThinkingLevel {
  const index = levels.indexOf(level);
  if (index === -1) return level;
  const next = Math.min(Math.max(index + direction, 0), levels.length - 1);
  return levels[next] ?? level;
}

export function thinkingLabel(level: ThinkingLevel): string {
  return `${GLYPHS.think} ${level}`;
}
