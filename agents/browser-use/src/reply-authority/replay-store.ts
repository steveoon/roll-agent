import { REPLY_AUTHORITY_CLOCK_SKEW_SECONDS } from "./schemas.ts";

let consumedEnvelopeJtis = new Map<string, number>();

function pruneExpiredEntries(nowSeconds: number): void {
  for (const [jti, exp] of consumedEnvelopeJtis) {
    if (exp < nowSeconds - REPLY_AUTHORITY_CLOCK_SKEW_SECONDS) {
      consumedEnvelopeJtis.delete(jti);
    }
  }
}

export function isReplyEnvelopeConsumed(
  jti: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  pruneExpiredEntries(nowSeconds);
  return consumedEnvelopeJtis.has(jti);
}

export function markReplyEnvelopeConsumed(
  jti: string,
  exp: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  pruneExpiredEntries(nowSeconds);
  consumedEnvelopeJtis.set(jti, exp);
}

export function resetReplyEnvelopeReplayStoreForTests(): void {
  consumedEnvelopeJtis = new Map<string, number>();
}
