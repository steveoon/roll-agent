import { z } from "zod";

// ========== Platform ==========

export const PLATFORMS = ["zhipin", "yupao"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

// ========== BrowserRuntime 配置 ==========

export const BrowserRuntimeConfigSchema = z.object({
  /** 是否无头模式（默认 true） */
  headless: z.boolean().default(true),
  /** 自定义 Chromium/Chrome 可执行文件路径 */
  executablePath: z.string().optional(),
  /** Chromium 额外启动参数 */
  args: z.array(z.string()).optional(),
  /** Session 持久化目录（默认 ~/.roll-agent/browser/sessions） */
  sessionsDir: z.string().optional(),
});

export type BrowserRuntimeConfig = z.infer<typeof BrowserRuntimeConfigSchema>;

// ========== Browser 运行状态 ==========

export const BrowserSessionInfoSchema = z.object({
  platform: PlatformSchema,
  pagesOpen: z.number(),
  hasLoginState: z.boolean(),
});

export type BrowserSessionInfo = z.infer<typeof BrowserSessionInfoSchema>;

export const BrowserStatusSchema = z.object({
  running: z.boolean(),
  headless: z.boolean(),
  activeSessions: z.array(BrowserSessionInfoSchema),
});

export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;

// ========== Page Snapshot ==========

export const PageSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  html: z.string(),
});

export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

// ========== Wait 策略选项 ==========

export const WaitOptionsSchema = z.object({
  timeout: z.number().default(30_000),
});

export type WaitOptions = z.infer<typeof WaitOptionsSchema>;
