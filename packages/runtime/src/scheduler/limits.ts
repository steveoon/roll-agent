export const SCHEDULER_LIMITS = {
  minIntervalMs: 60_000,
  claimLeaseMs: 120_000,
  leaseRenewIntervalMs: 30_000,
  retryBudget: 3,
  retryBackoffMs: 10_000,
  pollIntervalMs: 15_000,
  maxNameChars: 120,
  maxPromptChars: 4_000,
  maxOutputExcerptChars: 4_000,
} as const;
