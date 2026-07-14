import { SECRET_SENTINEL } from "../types.ts";
import type { ConfigPath } from "../types.ts";
import { getAtPath, isRecord } from "./config-value.ts";

export interface ConfigSecretPresentation {
  readonly secret: boolean;
  readonly configured: boolean;
}

export function createConfiguredSecretPathKeys(paths: readonly ConfigPath[]): ReadonlySet<string> {
  return new Set(paths.map((path) => JSON.stringify(path)));
}

export function resolveConfigSecretPresentation(
  staticSecret: boolean,
  path: ConfigPath,
  configuredSecretPathKeys: ReadonlySet<string>,
  value: unknown,
): ConfigSecretPresentation {
  const secret = staticSecret || configuredSecretPathKeys.has(JSON.stringify(path));
  return { secret, configured: secret && value === SECRET_SENTINEL };
}

export function findConfiguredSecretSentinelAtOrBelow(
  persisted: unknown,
  parentPath: ConfigPath,
  configuredSecretPathKeys: ReadonlySet<string>,
): ConfigPath | undefined {
  return findConfiguredSecretSentinel(
    getAtPath(persisted, parentPath),
    parentPath,
    configuredSecretPathKeys,
  );
}

function findConfiguredSecretSentinel(
  value: unknown,
  path: ConfigPath,
  configuredSecretPathKeys: ReadonlySet<string>,
): ConfigPath | undefined {
  if (value === SECRET_SENTINEL) {
    return configuredSecretPathKeys.has(JSON.stringify(path)) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const match = findConfiguredSecretSentinel(child, [...path, index], configuredSecretPathKeys);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const match = findConfiguredSecretSentinel(child, [...path, key], configuredSecretPathKeys);
    if (match !== undefined) return match;
  }
  return undefined;
}
