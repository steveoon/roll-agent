import { z } from "zod";

const browserPlatforms = ["zhipin", "yupao"] as const;
const browserRuntimeModes = ["managed-cdp", "remote-cdp", "existing-session"] as const;
const browserChannels = ["chrome", "chromium", "msedge"] as const;

const browserProfileColorSchema = z
  .string()
  .trim()
  .regex(/^#[\da-fA-F]{6}$/, "profileColor must be a hex RGB color such as #2563EB")
  .transform((value) => value.toUpperCase());

export const browserWindowBoundsSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const providerConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().optional(),
});

export const llmConfigSchema = z.object({
  defaultProvider: z.string(),
  defaultModel: z.string(),
  providers: z.record(z.string(), providerConfigSchema),
});

export const askConfigSchema = z.object({
  llmModel: z.string().optional(),
  confirmThreshold: z.number().optional(),
});

export const agentsConfigSchema = z.object({
  dataDir: z.string(),
  /** per-agent 环境变量：键为 agent name，值为 key-value 对 */
  env: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

export const browserInstanceConfigSchema = z
  .object({
    platform: z.enum(browserPlatforms).optional(),
    mode: z.enum(browserRuntimeModes).default("managed-cdp"),
    headless: z.boolean().optional(),
    cdpUrl: z.string().optional(),
    cdpHost: z.string().default("127.0.0.1"),
    cdpPort: z.number().int().min(1).max(65_535).optional(),
    channel: z.enum(browserChannels).default("chrome"),
    executablePath: z.string().optional(),
    userDataDir: z.string().trim().min(1),
    sessionsDir: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    profileName: z.string().trim().min(1).optional(),
    profileColor: browserProfileColorSchema.optional(),
    windowBounds: browserWindowBoundsSchema.optional(),
    trackingAgentId: z.string().trim().min(1).optional(),
  })
  .superRefine((instance, ctx) => {
    if (instance.mode === "managed-cdp" && instance.cdpPort === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cdpPort"],
        message: "managed-cdp browser instance requires cdpPort",
      });
    }
    if (
      (instance.mode === "remote-cdp" || instance.mode === "existing-session") &&
      instance.cdpUrl === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cdpUrl"],
        message: `${instance.mode} browser instance requires cdpUrl`,
      });
    }
  });

export const browserConfigSchema = z
  .object({
    defaultInstance: z.string().trim().min(1).optional(),
    instances: z.record(z.string(), browserInstanceConfigSchema).default({}),
  })
  .superRefine((browser, ctx) => {
    const instanceEntries = Object.entries(browser.instances);
    if (
      browser.defaultInstance !== undefined &&
      browser.instances[browser.defaultInstance] === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultInstance"],
        message: `defaultInstance "${browser.defaultInstance}" is not declared in browser.instances`,
      });
    }

    const seenPorts = new Map<number, string>();
    const seenUserDataDirs = new Map<string, string>();
    for (const [id, instance] of instanceEntries) {
      if (instance.cdpPort !== undefined) {
        const existing = seenPorts.get(instance.cdpPort);
        if (existing !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["instances", id, "cdpPort"],
            message: `cdpPort ${String(instance.cdpPort)} is already used by browser instance "${existing}"`,
          });
        } else {
          seenPorts.set(instance.cdpPort, id);
        }
      }

      const existingUserDataDir = seenUserDataDirs.get(instance.userDataDir);
      if (existingUserDataDir !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["instances", id, "userDataDir"],
          message: `userDataDir is already used by browser instance "${existingUserDataDir}"`,
        });
      } else {
        seenUserDataDirs.set(instance.userDataDir, id);
      }
    }
  });

export const rollConfigSchema = z.object({
  llm: llmConfigSchema,
  ask: askConfigSchema,
  agents: agentsConfigSchema,
  browser: browserConfigSchema.default({}),
});

export type RollConfig = z.infer<typeof rollConfigSchema>;
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
