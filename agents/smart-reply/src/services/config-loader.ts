import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ZhipinDataSchema } from "../types/zhipin.ts";
import type { ZhipinData } from "../types/zhipin.ts";
import { ReplyPolicyConfigSchema, DEFAULT_REPLY_POLICY } from "../types/reply-policy.ts";
import type { ReplyPolicyConfig } from "../types/reply-policy.ts";

function resolvePackageRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    if (existsSync(join(currentDir, "package.json"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not locate package root from ${startDir}`);
    }

    currentDir = parentDir;
  }
}

// Support both source execution (`src/services`) and bundled execution (`dist`).
const DATA_DIR = join(resolvePackageRoot(import.meta.dirname), "data");
const BRAND_CONFIG_PATH = join(DATA_DIR, "brand-config.json");
const REPLY_POLICY_PATH = join(DATA_DIR, "reply-policy.json");

const CACHE_TTL_MS = 5 * 60 * 1000;

let brandConfigCache: { data: ZhipinData; loadedAt: number } | null = null;
let replyPolicyCache: { data: ReplyPolicyConfig; loadedAt: number } | null = null;

function isFresh(loadedAt: number): boolean {
  return Date.now() - loadedAt < CACHE_TTL_MS;
}

export function loadBrandConfig(): ZhipinData {
  if (brandConfigCache && isFresh(brandConfigCache.loadedAt)) {
    return brandConfigCache.data;
  }
  const raw = readFileSync(BRAND_CONFIG_PATH, "utf-8");
  const data = ZhipinDataSchema.parse(JSON.parse(raw));
  brandConfigCache = { data, loadedAt: Date.now() };
  return data;
}

export function saveBrandConfig(data: ZhipinData): void {
  writeFileSync(BRAND_CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
  brandConfigCache = { data, loadedAt: Date.now() };
}

export type ReplyPolicySource = "file" | "default";

export interface ReplyPolicyLoadResult {
  readonly policy: ReplyPolicyConfig;
  readonly source: ReplyPolicySource;
}

let lastReplyPolicySource: ReplyPolicySource = "default";

export function loadReplyPolicy(): ReplyPolicyLoadResult {
  if (replyPolicyCache && isFresh(replyPolicyCache.loadedAt)) {
    return { policy: replyPolicyCache.data, source: lastReplyPolicySource };
  }
  try {
    const raw = readFileSync(REPLY_POLICY_PATH, "utf-8");
    const data = ReplyPolicyConfigSchema.parse(JSON.parse(raw));
    replyPolicyCache = { data, loadedAt: Date.now() };
    lastReplyPolicySource = "file";
    return { policy: data, source: "file" };
  } catch {
    lastReplyPolicySource = "default";
    return { policy: DEFAULT_REPLY_POLICY, source: "default" };
  }
}

export function saveReplyPolicy(policy: ReplyPolicyConfig): void {
  writeFileSync(REPLY_POLICY_PATH, JSON.stringify(policy, null, 2), "utf-8");
  replyPolicyCache = { data: policy, loadedAt: Date.now() };
  lastReplyPolicySource = "file";
}
