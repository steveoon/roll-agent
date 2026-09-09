import { z } from "zod";

export const BROWSER_SCRIPT_CAPABILITIES = ["read", "interact", "navigate", "capture"] as const;
export const BrowserScriptCapabilitySchema = z.enum(BROWSER_SCRIPT_CAPABILITIES);
export type BrowserScriptCapability = z.infer<typeof BrowserScriptCapabilitySchema>;

export const BrowserScriptLocatorSchema = z.union([
  z
    .object({
      css: z.string().min(1).max(2000),
      scope: z.string().min(1).max(2000).optional(),
      frameId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      role: z.string().min(1).max(100),
      name: z.string().max(2000),
      scope: z.string().min(1).max(2000).optional(),
      frameId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({ ref: z.string().regex(/^@e[1-9]\d*$/), snapshotId: z.string().min(1).max(100) })
    .strict(),
]);
export type BrowserScriptLocator = z.infer<typeof BrowserScriptLocatorSchema>;

export const BrowserScriptConditionSchema = z.union([
  z
    .object({
      target: BrowserScriptLocatorSchema,
      state: z.enum([
        "attached",
        "absent",
        "visible",
        "hidden",
        "enabled",
        "disabled",
        "checked",
        "unchecked",
      ]),
    })
    .strict(),
  z
    .object({
      target: BrowserScriptLocatorSchema,
      text: z.string().max(8000),
      match: z.enum(["equals", "contains"]).default("equals"),
    })
    .strict(),
  z.object({ target: BrowserScriptLocatorSchema, value: z.string().max(8000) }).strict(),
  z
    .object({
      url: z.string().url().max(8000),
      match: z.enum(["equals", "startsWith"]).default("equals"),
    })
    .strict(),
]);
export type BrowserScriptCondition = z.infer<typeof BrowserScriptConditionSchema>;

export const BrowserChooseOptionsSchema = z
  .object({
    label: z.string().min(1).max(500).optional(),
    value: z.string().max(8000).optional(),
    panel: z.string().min(1).max(2000).optional(),
    timeoutMs: z.number().int().min(100).max(10_000).default(3000),
    expect: BrowserScriptConditionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.label === undefined) === (value.value === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of label or value",
      });
    }
  });

export function normalizeBrowserOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Browser scripts require credential-free HTTP(S) origins");
  }
  return url.origin;
}

export const BrowserScriptOriginSchema = z
  .string()
  .max(2000)
  .url()
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      normalizeBrowserOrigin(value);
      if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Expected an origin without path, query or fragment");
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a credential-free HTTP(S) origin",
      });
    }
  })
  .transform(normalizeBrowserOrigin);

export const BrowserExecuteInputSchema = z.object({
  pageId: z.string().min(1),
  source: z.string().min(1).max(65_536),
  args: z.record(z.unknown()).default({}),
  capabilities: z.array(BrowserScriptCapabilitySchema).min(1).max(4),
  allowedOrigins: z.array(BrowserScriptOriginSchema).min(1).max(20),
  timeoutMs: z.number().int().min(100).max(30_000).default(30_000),
  maxCalls: z.number().int().min(1).max(100).default(100),
  preconditions: z.array(BrowserScriptConditionSchema).max(20).default([]),
  postconditions: z.array(BrowserScriptConditionSchema).max(20).default([]),
  scriptApproval: z.object({ id: z.string().min(1) }).optional(),
});
export type BrowserExecuteInput = z.infer<typeof BrowserExecuteInputSchema>;

export const BrowserScriptActionSchema = z.object({
  index: z.number().int(),
  method: z.string(),
  executed: z.boolean(),
  verification: z.enum(["not_requested", "passed", "failed"]),
  elapsedMs: z.number(),
  errorCode: z.string().optional(),
});
export type BrowserScriptAction = z.infer<typeof BrowserScriptActionSchema>;

export const BrowserExecuteResultSchema = z.object({
  executionId: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "timed_out"]),
  verification: z.enum(["passed", "not_requested", "failed"]),
  value: z.unknown().optional(),
  logs: z.array(z.string()),
  actions: z.array(BrowserScriptActionSchema),
  checks: z.array(
    z.object({
      passed: z.boolean(),
      kind: z.string(),
      elapsedMs: z.number(),
      actual: z
        .record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
        .optional(),
    }),
  ),
  observation: z.object({
    beforeUrl: z.string().optional(),
    afterUrl: z.string().optional(),
    changed: z.boolean(),
    changes: z.array(z.string().max(500)).max(25).optional(),
  }),
  artifacts: z.array(
    z.object({ id: z.string(), path: z.string(), mimeType: z.literal("image/png") }),
  ),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  metrics: z.object({
    elapsedMs: z.number(),
    helperCalls: z.number().int(),
    verifiedAssertions: z.number().int(),
  }),
});
export type BrowserExecuteResult = z.infer<typeof BrowserExecuteResultSchema>;

export class BrowserScriptError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserScriptError";
    this.code = code;
  }
}
