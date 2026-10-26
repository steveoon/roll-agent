import { z } from "zod";

export const RUNTIME_COMPACTION_STRATEGIES = ["summarize", "truncate"] as const;

export const runtimeCompactionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  strategy: z.enum(RUNTIME_COMPACTION_STRATEGIES).default("summarize"),
  timeoutMs: z.number().int().min(10_000).max(600_000).default(120_000),
  maxOutputTokens: z.number().int().min(2_048).max(32_768).default(8_192),
  threshold: z.number().min(0.1).max(0.95).default(0.75),
  keepRecentTurns: z.number().int().min(1).default(4),
  keepRecentTokens: z.number().int().min(1).default(32_000),
});

export const runtimeShellSessionSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  maxSessions: z.number().int().min(1).max(64).default(8),
  defaultYieldMs: z.number().int().min(250).max(30_000).default(10_000),
  maxOutputTokens: z.number().int().min(256).default(10_000),
});

export const runtimeShellSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  autoApproveSafe: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(1_000).max(600_000).default(10_000),
  maxTimeoutMs: z.number().int().min(1_000).max(600_000).default(600_000),
  maxCaptureBytes: z.number().int().min(16_384).default(1_048_576),
  maxModelOutputChars: z.number().int().min(1_000).default(16_000),
  session: runtimeShellSessionSettingsSchema.default({}),
});

/** Execution settings only. Provider credentials, discovery paths and install config belong to hosts. */
export const runtimeSettingsSchema = z.object({
  maxSteps: z.number().int().min(1).default(80),
  turnTimeoutMs: z.number().int().min(10_000).default(300_000),
  contextWindow: z.number().int().min(1).optional(),
  compaction: runtimeCompactionSettingsSchema.default({}),
  shell: runtimeShellSettingsSchema.default({}),
  instructions: z.string().trim().min(1).default("auto"),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
