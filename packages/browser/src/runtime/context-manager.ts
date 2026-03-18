import type { BrowserContext, Page, Cookie } from "playwright-core";
import type { Platform } from "../types/index.ts";
import type { BrowserRuntime } from "./browser-runtime.ts";
import type { SessionStore } from "../session/session-store.ts";
import { installLocalStorageSnapshot } from "../session/session-state.ts";

/**
 * 每个平台一个 BrowserContext，隔离 cookie/storage。
 *
 * 创建 context 时自动恢复持久化的 session 数据。
 */
export class BrowserContextManager {
  private readonly contexts = new Map<Platform, BrowserContext>();
  private readonly runtime: BrowserRuntime;
  private readonly sessionStore: SessionStore;

  constructor(runtime: BrowserRuntime, sessionStore: SessionStore) {
    this.runtime = runtime;
    this.sessionStore = sessionStore;
  }

  /** 获取或创建指定平台的 BrowserContext（自动恢复 cookies/localStorage） */
  async getOrCreateContext(platform: Platform): Promise<BrowserContext> {
    const existing = this.contexts.get(platform);
    if (existing) return existing;

    const browser = this.runtime.getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
    });

    // 恢复持久化的 cookies
    // loadCookies 返回的是我们自己通过 context.cookies() 保存的数据，结构一致
    const savedCookies = await this.sessionStore.loadCookies(platform);
    if (savedCookies && savedCookies.length > 0) {
      try {
        await context.addCookies(savedCookies as Cookie[]);
      } catch {
        // cookies 格式不兼容（如 Playwright 版本变更），跳过恢复
      }
    }

    const savedLocalStorage = await this.sessionStore.loadLocalStorage(platform);
    if (savedLocalStorage && Object.keys(savedLocalStorage).length > 0) {
      try {
        await installLocalStorageSnapshot(context, savedLocalStorage);
      } catch {
        // localStorage 恢复失败时跳过，避免阻断 context 创建
      }
    }

    this.contexts.set(platform, context);
    return context;
  }

  /** 获取指定平台的活跃 Page（没有则创建新 tab） */
  async getPage(platform: Platform): Promise<Page> {
    const context = await this.getOrCreateContext(platform);
    const pages = context.pages();
    const first = pages[0];
    return first ?? (await context.newPage());
  }

  /** 查询指定平台是否有已加载的 context */
  hasContext(platform: Platform): boolean {
    return this.contexts.has(platform);
  }

  /** 获取指定平台打开的页面数 */
  getPageCount(platform: Platform): number {
    const ctx = this.contexts.get(platform);
    return ctx ? ctx.pages().length : 0;
  }

  /** 获取所有活跃平台列表 */
  getActivePlatforms(): ReadonlyArray<Platform> {
    return [...this.contexts.keys()];
  }

  /** 关闭指定平台的 context */
  async closeContext(platform: Platform): Promise<void> {
    const ctx = this.contexts.get(platform);
    if (!ctx) return;
    await ctx.close();
    this.contexts.delete(platform);
  }

  /** 关闭所有 context */
  async closeAll(): Promise<void> {
    const platforms = [...this.contexts.keys()];
    await Promise.all(platforms.map((p) => this.closeContext(p)));
  }
}
