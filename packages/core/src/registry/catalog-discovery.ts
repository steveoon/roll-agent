import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { npmViewNetworkArgs, runPackageManager } from "../cli/utils/package-manager.ts";
import { getAgentCatalog } from "./catalog.ts";
import type { AgentCatalogEntry } from "./catalog.ts";
import type { RollConfig } from "../config/schema.ts";

const CATALOG_SCOPE = "@roll-agent/";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const SEARCH_LIMIT = 100;

export interface CatalogCacheFile {
  readonly checkedAt: number;
  readonly registry: string;
  readonly entries: readonly AgentCatalogEntry[];
}

export interface DiscoveredPackageInfo {
  readonly description?: string;
  readonly hasRollAgentManifest: boolean;
}

export interface DiscoveryCommandOptions {
  readonly registry?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ResolveCatalogCollaborators {
  readonly searchScopePackages?: (options: DiscoveryCommandOptions) => Promise<readonly string[]>;
  readonly fetchPackageInfo?: (
    packageName: string,
    options: DiscoveryCommandOptions,
  ) => Promise<DiscoveredPackageInfo | undefined>;
  readonly readCache?: () => CatalogCacheFile | undefined;
  readonly writeCache?: (cache: CatalogCacheFile) => void;
  readonly now?: () => number;
}

export interface ResolveCatalogOptions {
  readonly allowNetwork?: boolean;
  readonly forceRefresh?: boolean;
  readonly registry?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly collaborators?: ResolveCatalogCollaborators;
}

export async function resolveAgentCatalog(
  config?: RollConfig,
  options: ResolveCatalogOptions = {},
): Promise<readonly AgentCatalogEntry[]> {
  options.signal?.throwIfAborted();
  const builtIn = getAgentCatalog(config);
  const collaborators = options.collaborators ?? {};
  const readCache = collaborators.readCache ?? readCatalogCache;
  const writeCache = collaborators.writeCache ?? writeCatalogCache;
  const now = collaborators.now ?? Date.now;

  const cacheRegistry = options.registry ?? "";
  const rawCache = readCache();
  const cache = rawCache?.registry === cacheRegistry ? rawCache : undefined;
  if (!(options.forceRefresh ?? false) && cache && now() - cache.checkedAt < CACHE_TTL_MS) {
    options.signal?.throwIfAborted();
    return mergeCatalog(builtIn, cache.entries);
  }

  if (!(options.allowNetwork ?? true)) {
    options.signal?.throwIfAborted();
    return mergeCatalog(builtIn, cache?.entries ?? []);
  }

  const discovered = await discoverScopeAgents(builtIn, options, collaborators);
  options.signal?.throwIfAborted();
  if (discovered === undefined) {
    return mergeCatalog(builtIn, cache?.entries ?? []);
  }

  writeCache({ checkedAt: now(), registry: cacheRegistry, entries: discovered });
  return mergeCatalog(builtIn, discovered);
}

async function discoverScopeAgents(
  builtIn: readonly AgentCatalogEntry[],
  options: ResolveCatalogOptions,
  collaborators: ResolveCatalogCollaborators,
): Promise<readonly AgentCatalogEntry[] | undefined> {
  const search = collaborators.searchScopePackages ?? searchScopePackagesViaNpm;
  const fetchInfo = collaborators.fetchPackageInfo ?? fetchPackageInfoViaNpm;
  const commandOptions: DiscoveryCommandOptions = {
    ...(options.registry ? { registry: options.registry } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let names: readonly string[];
  try {
    names = await search(commandOptions);
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }

  const builtInPackages = new Set(builtIn.map((entry) => entry.packageName));
  const candidates = [...new Set(names)].filter(
    (name) => name.startsWith(CATALOG_SCOPE) && !builtInPackages.has(name),
  );

  const entries: AgentCatalogEntry[] = [];
  for (const packageName of candidates) {
    options.signal?.throwIfAborted();
    let info: DiscoveredPackageInfo | undefined;
    try {
      info = await fetchInfo(packageName, commandOptions);
      options.signal?.throwIfAborted();
    } catch {
      options.signal?.throwIfAborted();
      continue;
    }
    if (!info?.hasRollAgentManifest) {
      continue;
    }
    entries.push(buildDiscoveredEntry(packageName, info.description));
  }
  return entries;
}

function deriveShortName(packageName: string): string {
  const bareName = packageName.slice(CATALOG_SCOPE.length);
  const withoutSuffix = bareName.endsWith("-agent")
    ? bareName.slice(0, -"-agent".length)
    : bareName;
  return withoutSuffix.length > 0 ? withoutSuffix : bareName;
}

function buildDiscoveredEntry(
  packageName: string,
  description: string | undefined,
): AgentCatalogEntry {
  const trimmedDescription = description?.trim() ?? "";
  return {
    shortName: deriveShortName(packageName),
    packageName,
    skillName: packageName.slice(CATALOG_SCOPE.length),
    description: trimmedDescription.length > 0 ? trimmedDescription : packageName,
    requiredEnv: [],
  };
}

function mergeCatalog(
  builtIn: readonly AgentCatalogEntry[],
  discovered: readonly AgentCatalogEntry[],
): readonly AgentCatalogEntry[] {
  const seenPackages = new Set(builtIn.map((entry) => entry.packageName));
  const seenShortNames = new Set(builtIn.map((entry) => entry.shortName));
  const merged = [...builtIn];
  for (const entry of discovered) {
    if (seenPackages.has(entry.packageName)) {
      continue;
    }
    let shortName = entry.shortName;
    if (seenShortNames.has(shortName)) {
      shortName = entry.packageName.slice(CATALOG_SCOPE.length);
    }
    if (seenShortNames.has(shortName)) {
      continue;
    }
    merged.push(shortName === entry.shortName ? entry : { ...entry, shortName });
    seenPackages.add(entry.packageName);
    seenShortNames.add(shortName);
  }
  return merged;
}

async function searchScopePackagesViaNpm(
  options: DiscoveryCommandOptions,
): Promise<readonly string[]> {
  const networkArgs = npmViewNetworkArgs({
    ...(options.registry ? { registry: options.registry } : {}),
  });
  const { stdout } = await runPackageManager(
    {
      command: "npm",
      args: [
        "search",
        CATALOG_SCOPE.slice(0, -1),
        "--json",
        `--searchlimit=${String(SEARCH_LIMIT)}`,
        ...networkArgs,
      ],
    },
    {
      timeout: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) =>
    typeof item === "object" && item !== null && "name" in item && typeof item.name === "string"
      ? [item.name]
      : [],
  );
}

async function fetchPackageInfoViaNpm(
  packageName: string,
  options: DiscoveryCommandOptions,
): Promise<DiscoveredPackageInfo | undefined> {
  const networkArgs = npmViewNetworkArgs({
    ...(options.registry ? { registry: options.registry } : {}),
  });
  const { stdout } = await runPackageManager(
    {
      command: "npm",
      args: ["view", packageName, "name", "description", "rollAgent", "--json", ...networkArgs],
    },
    {
      timeout: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
    hasRollAgentManifest: typeof record["rollAgent"] === "object" && record["rollAgent"] !== null,
  };
}

function getCatalogCachePath(): string {
  return resolve(homedir(), ".roll-agent", "catalog-cache.json");
}

function isCatalogEntry(value: unknown): value is AgentCatalogEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["shortName"] === "string" &&
    typeof record["packageName"] === "string" &&
    typeof record["skillName"] === "string" &&
    typeof record["description"] === "string" &&
    Array.isArray(record["requiredEnv"]) &&
    record["requiredEnv"].every((item) => typeof item === "string")
  );
}

function isCatalogCacheFile(value: unknown): value is CatalogCacheFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["checkedAt"] === "number" &&
    typeof record["registry"] === "string" &&
    Array.isArray(record["entries"]) &&
    record["entries"].every((entry) => isCatalogEntry(entry))
  );
}

function readCatalogCache(): CatalogCacheFile | undefined {
  const cachePath = getCatalogCachePath();
  if (!existsSync(cachePath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf-8"));
    return isCatalogCacheFile(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCatalogCache(cache: CatalogCacheFile): void {
  try {
    const cachePath = getCatalogCachePath();
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  } catch {
    // cache write failure should not block the main flow
  }
}
