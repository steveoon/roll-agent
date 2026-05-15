import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import type { BrowserRuntimeConfig } from "@roll-agent/browser";

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
