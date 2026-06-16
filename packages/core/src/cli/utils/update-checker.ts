import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { npmViewNetworkArgs, runPackageManager } from "./package-manager.ts";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CORE_PACKAGE_NAME = "@roll-agent/core";
const DEFAULT_VIEW_TIMEOUT_MS = 10_000;

export const PUBLISHED_PACKAGE_UPDATE_STATUSES = [
  "up-to-date",
  "update-available",
  "pinned-behind",
  "unsupported-spec",
  "unknown",
] as const;
export type PublishedPackageUpdateStatus = (typeof PUBLISHED_PACKAGE_UPDATE_STATUSES)[number];

interface PackageVersionCacheEntry {
  readonly latestVersion: string;
  readonly checkedAt: number;
}

interface PackageVersionCacheFile {
  readonly packages: Readonly<Record<string, PackageVersionCacheEntry>>;
}

interface LegacyUpdateCache {
  readonly latestVersion: string;
  readonly checkedAt: number;
}

interface PackageVersionQueryOptions {
  readonly forceRefresh?: boolean;
  readonly allowNetwork?: boolean;
  /** 显式 registry（镜像源），透传给 `npm view`。 */
  readonly registry?: string;
  /** 透传给 npm 的 `--fetch-retries`。 */
  readonly fetchRetries?: number;
  /** `npm view` 单次超时（毫秒），默认 10s。慢网下仍有缓存兜底。 */
  readonly timeoutMs?: number;
}

export interface PublishedPackageUpdateInfo {
  readonly packageName: string;
  readonly currentVersion?: string;
  readonly latestVersion?: string;
  readonly status: PublishedPackageUpdateStatus;
}

export interface UpdateInfo {
  readonly current: string;
  readonly latest: string;
  readonly hasUpdate: boolean;
}

function getCachePath(): string {
  return resolve(homedir(), ".roll-agent", "update-check.json");
}

function isPackageVersionCacheEntry(value: unknown): value is PackageVersionCacheEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("latestVersion" in value) || !("checkedAt" in value)) {
    return false;
  }
  return (
    typeof value.latestVersion === "string" &&
    value.latestVersion.length > 0 &&
    typeof value.checkedAt === "number"
  );
}

function isPackageVersionCacheFile(value: unknown): value is PackageVersionCacheFile {
  if (typeof value !== "object" || value === null || !("packages" in value)) {
    return false;
  }
  if (typeof value.packages !== "object" || value.packages === null) {
    return false;
  }
  return Object.values(value.packages).every((entry) => isPackageVersionCacheEntry(entry));
}

function isLegacyUpdateCache(value: unknown): value is LegacyUpdateCache {
  return isPackageVersionCacheEntry(value);
}

function readCache(): PackageVersionCacheFile | undefined {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isPackageVersionCacheFile(parsed)) {
      return parsed;
    }
    if (isLegacyUpdateCache(parsed)) {
      return {
        packages: {
          [CORE_PACKAGE_NAME]: {
            latestVersion: parsed.latestVersion,
            checkedAt: parsed.checkedAt,
          },
        },
      };
    }
  } catch {
    // ignore invalid cache file
  }
  return undefined;
}

function writeCache(cache: PackageVersionCacheFile): void {
  try {
    const cachePath = getCachePath();
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  } catch {
    // cache write failure should not block the main flow
  }
}

function writePackageCacheEntry(packageName: string, latestVersion: string): void {
  const previous = readCache();
  const nextPackages = {
    ...(previous?.packages ?? {}),
    [packageName]: {
      latestVersion,
      checkedAt: Date.now(),
    },
  };
  writeCache({ packages: nextPackages });
}

function readPackageCacheEntry(packageName: string): PackageVersionCacheEntry | undefined {
  return readCache()?.packages[packageName];
}

async function fetchLatestPublishedVersionFromRegistry(
  packageName: string,
  options: PackageVersionQueryOptions = {},
): Promise<string | undefined> {
  try {
    const networkArgs = npmViewNetworkArgs({
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.fetchRetries !== undefined ? { fetchRetries: options.fetchRetries } : {}),
    });
    const { stdout } = await runPackageManager(
      {
        command: "npm",
        args: ["view", packageName, "version", "--json", ...networkArgs],
      },
      {
        timeout: options.timeoutMs ?? DEFAULT_VIEW_TIMEOUT_MS,
      },
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchLatestPublishedVersion(
  packageName: string,
  options: PackageVersionQueryOptions = {},
): Promise<string | undefined> {
  const forceRefresh = options.forceRefresh ?? false;
  const allowNetwork = options.allowNetwork ?? true;
  const cache = readPackageCacheEntry(packageName);

  if (!forceRefresh && cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
    return cache.latestVersion;
  }

  if (!allowNetwork) {
    return cache?.latestVersion;
  }

  const latest = await fetchLatestPublishedVersionFromRegistry(packageName, options);
  if (latest) {
    writePackageCacheEntry(packageName, latest);
    return latest;
  }

  return cache?.latestVersion;
}

export function getCurrentVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname, "../../../package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg: unknown = JSON.parse(raw);
    if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
      const version = (pkg as { version: unknown }).version;
      if (typeof version === "string") {
        return version;
      }
    }
  } catch {
    // fallback
  }
  return "0.0.0";
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): readonly number[] => {
    return value.replace(/^v/, "").split(".").map(Number);
  };
  const latestParts = parse(latest);
  const currentParts = parse(current);
  for (let i = 0; i < 3; i += 1) {
    const latestValue = latestParts[i] ?? 0;
    const currentValue = currentParts[i] ?? 0;
    if (latestValue > currentValue) {
      return true;
    }
    if (latestValue < currentValue) {
      return false;
    }
  }
  return false;
}

function isRegistryPublishedPackageSpec(packageName: string, packageSpec: string): boolean {
  const unsupportedPrefixes = [
    "file:",
    "git+",
    "http://",
    "https://",
    "link:",
    "workspace:",
    "npm:",
  ];
  if (unsupportedPrefixes.some((prefix) => packageSpec.startsWith(prefix))) {
    return false;
  }
  if (
    packageSpec.startsWith(".") ||
    packageSpec.startsWith("/") ||
    packageSpec.startsWith("~") ||
    packageSpec.endsWith(".tgz") ||
    packageSpec.endsWith(".tar.gz")
  ) {
    return false;
  }
  return packageSpec === packageName || packageSpec.startsWith(`${packageName}@`);
}

function getVersionSpecifier(packageName: string, packageSpec: string): string | undefined {
  if (!packageSpec.startsWith(`${packageName}@`)) {
    return undefined;
  }
  return packageSpec.slice(packageName.length + 1);
}

export function isPinnedPublishedPackageSpec(packageName: string, packageSpec: string): boolean {
  const versionSpecifier = getVersionSpecifier(packageName, packageSpec);
  if (!versionSpecifier) {
    return false;
  }
  const normalized = versionSpecifier.replace(/^v/, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized);
}

export async function checkPublishedPackageUpdate(
  input: {
    packageName: string;
    packageSpec: string;
    currentVersion?: string;
  },
  options: PackageVersionQueryOptions = {},
): Promise<PublishedPackageUpdateInfo> {
  const { packageName, packageSpec, currentVersion } = input;

  if (!isRegistryPublishedPackageSpec(packageName, packageSpec)) {
    return {
      packageName,
      ...(currentVersion ? { currentVersion } : {}),
      status: "unsupported-spec",
    };
  }

  if (!currentVersion) {
    return {
      packageName,
      status: "unknown",
    };
  }

  const latestVersion = await fetchLatestPublishedVersion(packageName, options);
  if (!latestVersion) {
    return {
      packageName,
      currentVersion,
      status: "unknown",
    };
  }

  if (!isNewerVersion(latestVersion, currentVersion)) {
    return {
      packageName,
      currentVersion,
      latestVersion,
      status: "up-to-date",
    };
  }

  if (isPinnedPublishedPackageSpec(packageName, packageSpec)) {
    return {
      packageName,
      currentVersion,
      latestVersion,
      status: "pinned-behind",
    };
  }

  return {
    packageName,
    currentVersion,
    latestVersion,
    status: "update-available",
  };
}

export async function checkForUpdate(
  options: PackageVersionQueryOptions = {},
): Promise<UpdateInfo> {
  const current = getCurrentVersion();
  const latest = (await fetchLatestPublishedVersion(CORE_PACKAGE_NAME, options)) ?? current;

  return {
    current,
    latest,
    hasUpdate: isNewerVersion(latest, current),
  };
}
