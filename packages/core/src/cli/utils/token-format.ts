import type { SessionTokenUsage } from "@roll-agent/runtime";

const DEFAULT_BASELINE_HEADROOM = 12_000;
const BASELINE_HEADROOM_CAP_RATIO = 0.2;

export interface UsageLineParts {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly sessionTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly percentLeft?: number;
  readonly usedTokens?: number;
  readonly contextWindow?: number;
}

export interface UsagePartsOptions {
  readonly baselineHeadroom?: number;
}

export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function sessionTotal(usage: SessionTokenUsage): number {
  if (usage.totalTokens !== undefined && usage.totalTokens > 0) {
    return usage.totalTokens;
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function percentContextLeft(
  usedTokens: number,
  contextWindow: number,
  baselineHeadroom: number,
): number {
  const baseline = Math.min(
    baselineHeadroom,
    Math.floor(contextWindow * BASELINE_HEADROOM_CAP_RATIO),
  );
  const effectiveWindow = Math.max(contextWindow - baseline, 1);
  const used = Math.max(usedTokens - baseline, 0);
  const remaining = Math.max(effectiveWindow - used, 0);
  return Math.min(Math.max(Math.round((remaining / effectiveWindow) * 100), 0), 100);
}

export function computeUsageParts(
  turn: SessionTokenUsage | undefined,
  session: SessionTokenUsage | undefined,
  contextWindow: number | undefined,
  contextInputTokens: number | undefined,
  options?: UsagePartsOptions,
): UsageLineParts {
  const usedTokens = contextInputTokens ?? turn?.inputTokens;
  const baselineHeadroom = options?.baselineHeadroom ?? DEFAULT_BASELINE_HEADROOM;
  const cached = turn?.cachedInputTokens;
  const reasoning = turn?.reasoningTokens;
  return {
    ...(turn?.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
    ...(turn?.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
    ...(session ? { sessionTokens: sessionTotal(session) } : {}),
    ...(cached !== undefined && cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(contextWindow !== undefined && usedTokens !== undefined
      ? {
          percentLeft: percentContextLeft(usedTokens, contextWindow, baselineHeadroom),
          usedTokens,
          contextWindow,
        }
      : {}),
  };
}

export function formatUsageLine(parts: UsageLineParts): string | undefined {
  const segments: string[] = [];
  if (parts.inputTokens !== undefined) {
    const cached =
      parts.cachedInputTokens !== undefined
        ? ` (+${formatTokens(parts.cachedInputTokens)} cached)`
        : "";
    segments.push(`in ${formatTokens(parts.inputTokens)}${cached}`);
  }
  if (parts.outputTokens !== undefined) {
    const reasoning =
      parts.reasoningTokens !== undefined
        ? ` (+${formatTokens(parts.reasoningTokens)} reasoning)`
        : "";
    segments.push(`out ${formatTokens(parts.outputTokens)}${reasoning}`);
  }
  if (parts.sessionTokens !== undefined) {
    segments.push(`session ${formatTokens(parts.sessionTokens)}`);
  }
  if (
    parts.percentLeft !== undefined &&
    parts.usedTokens !== undefined &&
    parts.contextWindow !== undefined
  ) {
    segments.push(
      `${String(parts.percentLeft)}% left (${formatTokens(parts.usedTokens)}/${formatTokens(parts.contextWindow)})`,
    );
  }
  return segments.length > 0 ? `↳ ${segments.join(" · ")}` : undefined;
}
