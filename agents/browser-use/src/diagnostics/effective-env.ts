import { createHash } from "node:crypto";
import { z } from "zod";

export const BROWSER_USE_DECLARED_ENV_KEYS = [
  "REPLY_AUTHORITY_KEYS_URL",
  "RECRUITMENT_EVENTS_ENABLED",
  "RECRUITMENT_EVENTS_API_BASE_URL",
  "RECRUITMENT_EVENTS_API_TOKEN",
  "RECRUITMENT_EVENTS_DEFAULT_AGENT_ID",
  "BROWSER_VISUAL_CURSOR",
  "BROWSER_VISUAL_ACTIVITY",
] as const;

const EFFECTIVE_ENV_FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;

export const EffectiveEnvSourceSchema = z.object({
  present: z.boolean(),
  fingerprint: z.string().regex(EFFECTIVE_ENV_FINGERPRINT_PATTERN).optional(),
});

export const EffectiveEnvSourcesSchema = z.record(EffectiveEnvSourceSchema);

export type EffectiveEnvSources = z.infer<typeof EffectiveEnvSourcesSchema>;

export function collectEffectiveEnvSources(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EffectiveEnvSources {
  return Object.fromEntries(
    names.map((name) => {
      const value = env[name];
      if (typeof value === "string" && value.length > 0) {
        return [name, { present: true, fingerprint: createEnvFingerprint(value) }];
      }

      return [name, { present: false }];
    }),
  );
}

function createEnvFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
