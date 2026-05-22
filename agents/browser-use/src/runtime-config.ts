import {
  BrowserRuntimeConfigSchema,
  BrowserRuntimeModeSchema,
  BrowserChannelSchema,
  BrowserWindowBoundsSchema,
  PlatformSchema,
} from "@roll-agent/browser";
import type { BrowserRuntimeConfig } from "@roll-agent/browser";
import { z } from "zod";

export const BrowserInstanceConfigSchema = z
  .object({
    platform: PlatformSchema.optional(),
    mode: BrowserRuntimeModeSchema.default("managed-cdp"),
    headless: z.boolean().optional(),
    cdpUrl: z.string().optional(),
    cdpHost: z.string().default("127.0.0.1"),
    cdpPort: z.number().int().min(1).max(65_535).optional(),
    channel: BrowserChannelSchema.default("chrome"),
    executablePath: z.string().optional(),
    userDataDir: z.string().trim().min(1),
    sessionsDir: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    profileName: z.string().trim().min(1).optional(),
    windowBounds: BrowserWindowBoundsSchema.optional(),
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

export const BrowserInstancesConfigSchema = z
  .object({
    defaultInstance: z.string().trim().min(1).optional(),
    instances: z.record(z.string(), BrowserInstanceConfigSchema).default({}),
  })
  .superRefine((browser, ctx) => {
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
    for (const [id, instance] of Object.entries(browser.instances)) {
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

export type BrowserInstancesConfig = z.infer<typeof BrowserInstancesConfigSchema>;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean env value "true" or "false", received "${value}".`);
}

function parseIntegerEnv(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer, received "${value}".`);
  }
  return parsed;
}

function parseArgsJson(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("BROWSER_ARGS_JSON must be a JSON string array.");
  }
  return parsed;
}

function parseSecurityJson(value: string | undefined): unknown | undefined {
  if (value === undefined) return undefined;

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `BROWSER_SECURITY_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseBrowserInstancesJson(value: string | undefined): BrowserInstancesConfig | undefined {
  if (value === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `BROWSER_INSTANCES_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return BrowserInstancesConfigSchema.parse(parsed);
}

export function loadRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrowserRuntimeConfig {
  return BrowserRuntimeConfigSchema.parse({
    mode: env["BROWSER_MODE"],
    headless: parseBooleanEnv(env["BROWSER_HEADLESS"]),
    cdpUrl: env["BROWSER_CDP_URL"],
    cdpHost: env["BROWSER_CDP_HOST"],
    cdpPort: parseIntegerEnv(env["BROWSER_CDP_PORT"], "BROWSER_CDP_PORT"),
    channel: env["BROWSER_CHANNEL"],
    executablePath: env["BROWSER_EXECUTABLE_PATH"],
    userDataDir: env["BROWSER_USER_DATA_DIR"],
    args: parseArgsJson(env["BROWSER_ARGS_JSON"]),
    sessionsDir: env["BROWSER_SESSIONS_DIR"],
    security: parseSecurityJson(env["BROWSER_SECURITY_JSON"]),
  });
}

export function loadBrowserInstancesConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrowserInstancesConfig | undefined {
  return parseBrowserInstancesJson(env["BROWSER_INSTANCES_JSON"]);
}
