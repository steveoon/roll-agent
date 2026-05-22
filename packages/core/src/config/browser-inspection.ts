import type { BrowserConfig } from "./schema.ts";

export const LEGACY_BROWSER_IDENTITY_ENV_KEYS = [
  "BROWSER_CDP_PORT",
  "BROWSER_USER_DATA_DIR",
  "BROWSER_CDP_URL",
  "BROWSER_SESSIONS_DIR",
] as const;

export type LegacyBrowserIdentityEnvKey = (typeof LEGACY_BROWSER_IDENTITY_ENV_KEYS)[number];

export function collectBrowserConfigWarnings(
  browserConfig: BrowserConfig,
  agentEnv: Readonly<Record<string, string>> | undefined,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const instanceIds = Object.keys(browserConfig.instances);
  if (instanceIds.length === 0) {
    return [];
  }

  const warnings: string[] = [];

  if (instanceIds.length > 1 && browserConfig.defaultInstance === undefined) {
    warnings.push(
      `browser.instances 声明了 ${String(instanceIds.length)} 个实例，但未配置 browser.default-instance；未显式传 browserInstance 的 tool 调用会返回 needs_input`,
    );
  }

  const legacyKeys = LEGACY_BROWSER_IDENTITY_ENV_KEYS.filter((key) => {
    const configuredValue = agentEnv?.[key];
    const inheritedValue = inheritedEnv[key];
    return (
      (configuredValue !== undefined && configuredValue.length > 0) ||
      (inheritedValue !== undefined && inheritedValue.length > 0)
    );
  });
  if (legacyKeys.length > 0) {
    warnings.push(
      `browser.instances 已配置，agents.env 或 shell 中的 ${legacyKeys.join(", ")} 会被忽略；实例身份以 browser.instances 为准`,
    );
  }

  return warnings;
}
