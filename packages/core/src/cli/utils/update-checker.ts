import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

/** 缓存有效期：24 小时 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 包名 */
const PACKAGE_NAME = "@roll-agent/core";

/** 缓存文件路径 */
function getCachePath(): string {
  return resolve(homedir(), ".roll-agent", "update-check.json");
}

interface UpdateCache {
  readonly latestVersion: string;
  readonly checkedAt: number;
}

interface CheckForUpdateOptions {
  /** 强制忽略缓存，始终尝试联网查询 */
  readonly forceRefresh?: boolean;
  /** 是否允许联网查询 npm registry */
  readonly allowNetwork?: boolean;
}

function isUpdateCache(value: unknown): value is UpdateCache {
  if (typeof value !== "object" || value === null) return false;
  if (!("latestVersion" in value) || !("checkedAt" in value)) return false;
  return typeof value.latestVersion === "string" && typeof value.checkedAt === "number";
}

/** 读取缓存 */
function readCache(): UpdateCache | undefined {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return undefined;

  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isUpdateCache(parsed)) return parsed;
  } catch {
    // 缓存损坏，忽略
  }
  return undefined;
}

/** 写入缓存 */
function writeCache(latestVersion: string): void {
  try {
    const cachePath = getCachePath();
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const cache: UpdateCache = { latestVersion, checkedAt: Date.now() };
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/** 从 npm registry 查询最新版本 */
export async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", PACKAGE_NAME, "version"], {
      timeout: 5000,
      encoding: "utf-8",
    });
    const version = stdout.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/** 获取当前安装的版本 */
export function getCurrentVersion(): string {
  // 从 package.json 读取，兼容开发和安装环境
  try {
    const pkgPath = resolve(import.meta.dirname, "../../../package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg: unknown = JSON.parse(raw);
    if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
      const version = (pkg as { version: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // fallback
  }
  return "0.0.0";
}

export interface UpdateInfo {
  readonly current: string;
  readonly latest: string;
  readonly hasUpdate: boolean;
}

/** 比较语义化版本，返回 a > b */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): readonly number[] => v.replace(/^v/, "").split(".").map(Number);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

/**
 * 检查是否有新版本可用。
 *
 * 使用 24h 文件缓存避免频繁网络请求。
 * 设计为不抛异常 — 任何失败静默返回无更新。
 */
export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateInfo> {
  const forceRefresh = options.forceRefresh ?? false;
  const allowNetwork = options.allowNetwork ?? true;
  const current = getCurrentVersion();
  const cache = readCache();

  // 优先读缓存
  if (!forceRefresh && cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
    return {
      current,
      latest: cache.latestVersion,
      hasUpdate: isNewerVersion(cache.latestVersion, current),
    };
  }

  if (!allowNetwork) {
    if (cache) {
      return {
        current,
        latest: cache.latestVersion,
        hasUpdate: isNewerVersion(cache.latestVersion, current),
      };
    }
    return { current, latest: current, hasUpdate: false };
  }

  // 缓存过期或不存在，查询 npm
  const latest = await fetchLatestVersion();
  if (latest) {
    writeCache(latest);
    return { current, latest, hasUpdate: isNewerVersion(latest, current) };
  }

  // 查询失败，使用旧缓存或返回无更新
  if (cache) {
    return {
      current,
      latest: cache.latestVersion,
      hasUpdate: isNewerVersion(cache.latestVersion, current),
    };
  }

  return { current, latest: current, hasUpdate: false };
}
