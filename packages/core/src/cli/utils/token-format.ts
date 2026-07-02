import type { SessionTokenUsage } from "@roll-agent/runtime";

const DEFAULT_BASELINE_HEADROOM = 12_000;
const BASELINE_HEADROOM_CAP_RATIO = 0.2;

export interface UsageLineParts {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly sessionTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly percentLeft?: number;
  readonly usedTokens?: number;
  readonly contextWindow?: number;
}

export interface UsagePartsOptions {
  readonly baselineHeadroom?: number;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1000) {
    return `${trimTrailingZero((value / 1000).toFixed(1))}k`;
  }
  return String(value);
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
  const cacheWrite = turn?.cacheWriteTokens;
  const reasoning = turn?.reasoningTokens;
  return {
    ...(turn?.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
    ...(turn?.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
    ...(session ? { sessionTokens: sessionTotal(session) } : {}),
    ...(cached !== undefined && cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
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

export function formatTurnUsage(parts: UsageLineParts): string | undefined {
  const bits: string[] = [];
  if (parts.inputTokens !== undefined) {
    const cacheBits: string[] = [];
    if (parts.cachedInputTokens !== undefined) {
      cacheBits.push(`+${formatTokens(parts.cachedInputTokens)} cached`);
    }
    if (parts.cacheWriteTokens !== undefined) {
      cacheBits.push(`+${formatTokens(parts.cacheWriteTokens)} cache-write`);
    }
    const cached = cacheBits.length > 0 ? ` (${cacheBits.join(", ")})` : "";
    bits.push(`in ${formatTokens(parts.inputTokens)}${cached}`);
  }
  if (parts.outputTokens !== undefined) {
    const reasoning =
      parts.reasoningTokens !== undefined
        ? ` (+${formatTokens(parts.reasoningTokens)} reasoning)`
        : "";
    bits.push(`out ${formatTokens(parts.outputTokens)}${reasoning}`);
  }
  return bits.length > 0 ? `turn ${bits.join(" ")}` : undefined;
}

export function formatContextUsage(parts: UsageLineParts): string | undefined {
  if (
    parts.percentLeft === undefined ||
    parts.usedTokens === undefined ||
    parts.contextWindow === undefined
  ) {
    return undefined;
  }
  return `ctx ${formatTokens(parts.usedTokens)}/${formatTokens(parts.contextWindow)} (${String(parts.percentLeft)}% left)`;
}

export function formatThroughput(tokensPerSecond: number | undefined): string | undefined {
  if (tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    return undefined;
  }
  const value = tokensPerSecond >= 10 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1);
  return `${String(value)} tok/s`;
}

export function contextPressure(percentLeft: number | undefined): "ok" | "warn" | "critical" {
  if (percentLeft === undefined || percentLeft > 25) {
    return "ok";
  }
  return percentLeft > 10 ? "warn" : "critical";
}

export function formatUsageLine(parts: UsageLineParts): string | undefined {
  const segments: string[] = [];
  const turn = formatTurnUsage(parts);
  if (turn !== undefined) {
    segments.push(turn);
  }
  if (parts.sessionTokens !== undefined) {
    segments.push(`session ${formatTokens(parts.sessionTokens)}`);
  }
  const context = formatContextUsage(parts);
  if (context !== undefined) {
    segments.push(context);
  }
  return segments.length > 0 ? `↳ ${segments.join(" · ")}` : undefined;
}
