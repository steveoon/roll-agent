import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type { BrowserRuntimeConfig } from "../types/index.ts";

/**
 * 管理 Chromium 浏览器进程的生命周期。
 *
 * 由 Agent 进程持有，生命周期 = Agent 服务进程生命周期。
 */
export class BrowserRuntime {
  private browser: Browser | undefined;
  private readonly config: BrowserRuntimeConfig;

  constructor(config: BrowserRuntimeConfig) {
    this.config = config;
  }

  /** 启动 Chromium 进程 */
  async start(): Promise<void> {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: this.config.headless,
      ...(this.config.executablePath !== undefined
        ? { executablePath: this.config.executablePath }
        : {}),
      ...(this.config.args !== undefined ? { args: this.config.args } : {}),
    });
  }

  /** 关闭 Chromium 进程 */
  async stop(): Promise<void> {
    if (!this.browser) return;

    await this.browser.close();
    this.browser = undefined;
  }

  /** Chromium 是否正在运行 */
  isRunning(): boolean {
    return this.browser !== undefined && this.browser.isConnected();
  }

  /** 获取 Browser 实例（未启动时抛出异常） */
  getBrowser(): Browser {
    if (!this.browser) {
      throw new Error("BrowserRuntime not started. Call start() first.");
    }
    return this.browser;
  }

  /** 当前配置 */
  getConfig(): BrowserRuntimeConfig {
    return this.config;
  }
}
