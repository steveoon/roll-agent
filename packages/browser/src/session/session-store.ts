import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Platform } from "../types/index.ts";

const DEFAULT_SESSIONS_DIR = join(homedir(), ".roll-agent", "browser", "sessions");

/**
 * 将 cookies / localStorage 持久化到磁盘。
 *
 * 存储路径：{sessionsDir}/{platform}/cookies.json | localStorage.json
 *
 * 触发时机由调用方显式控制（登录成功后、状态变更操作后）。
 * 恢复时机：BrowserContextManager.getOrCreateContext() 时自动加载。
 */
export class SessionStore {
  private readonly baseDir: string;

  constructor(sessionsDir?: string) {
    this.baseDir = sessionsDir ?? DEFAULT_SESSIONS_DIR;
  }

  /** 持久化平台 cookies */
  async saveCookies(platform: Platform, cookies: ReadonlyArray<unknown>): Promise<void> {
    const dir = this.platformDir(platform);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cookies.json"), JSON.stringify(cookies, null, 2), "utf-8");
  }

  /** 加载平台 cookies（不存在则返回 undefined） */
  async loadCookies(platform: Platform): Promise<ReadonlyArray<unknown> | undefined> {
    try {
      const raw = await readFile(join(this.platformDir(platform), "cookies.json"), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** 持久化平台 localStorage */
  async saveLocalStorage(platform: Platform, data: Record<string, string>): Promise<void> {
    const dir = this.platformDir(platform);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "localStorage.json"), JSON.stringify(data, null, 2), "utf-8");
  }

  /** 加载平台 localStorage（不存在则返回 undefined） */
  async loadLocalStorage(platform: Platform): Promise<Record<string, string> | undefined> {
    try {
      const raw = await readFile(join(this.platformDir(platform), "localStorage.json"), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** 清除平台的所有持久化数据 */
  async clear(platform: Platform): Promise<void> {
    try {
      await rm(this.platformDir(platform), { recursive: true, force: true });
    } catch {
      // ignore — directory may not exist
    }
  }

  private platformDir(platform: Platform): string {
    return join(this.baseDir, platform);
  }
}
