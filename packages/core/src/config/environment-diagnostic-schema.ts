import { z } from "zod/v4";

// Shared by the local host and UI. No filesystem imports or credential values.
export const environmentIssueSchema = z
  .object({
    code: z.enum(["env-unresolved", "secrets-unreadable", "config-invalid", "model-unconfigured"]),
    severity: z.enum(["error", "warning"]),
    variable: z.string().max(160).optional(),
    paths: z.array(z.string().max(160)).max(8),
    message: z.string().max(400),
    remedy: z.string().max(500),
  })
  .strict();
export const environmentDiagnosticsSchema = z
  .object({
    environment: z.enum(["service", "estimated-service"]),
    checkedAt: z.string().datetime(),
    configPath: z.string().max(1024).optional(),
    blocking: z.boolean(),
    truncated: z.boolean(),
    issues: z.array(environmentIssueSchema).max(16),
  })
  .strict();
export type EnvironmentIssue = z.infer<typeof environmentIssueSchema>;
export type EnvironmentDiagnostics = z.infer<typeof environmentDiagnosticsSchema>;
