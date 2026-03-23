import { z } from "zod";

// ========== Platform ==========

export const PLATFORMS = ["zhipin", "yupao"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

// ========== BrowserRuntime 配置 ==========

/**
 * Playwright channel：决定启动哪个浏览器。
 * - "chrome"：系统 Chrome（默认，无需额外安装）
 * - "chromium"：Playwright 自带 Chromium（需 npx playwright install chromium）
 * - "msedge"：系统 Edge
 */
export const BROWSER_CHANNELS = ["chrome", "chromium", "msedge"] as const;
export const BrowserChannelSchema = z.enum(BROWSER_CHANNELS);
export type BrowserChannel = z.infer<typeof BrowserChannelSchema>;

export const BROWSER_RUNTIME_MODES = ["managed-cdp", "remote-cdp", "existing-session"] as const;
export const BrowserRuntimeModeSchema = z.enum(BROWSER_RUNTIME_MODES);
export type BrowserRuntimeMode = z.infer<typeof BrowserRuntimeModeSchema>;

export const BrowserRuntimeConfigSchema = z
  .object({
    /**
     * Browser runtime 模式：
     * - managed-cdp: 本地启动真实浏览器，使用 userDataDir + CDP attach
     * - remote-cdp: 连接远端 CDP（Browserless / Browserbase / 自托管 Chrome）
     * - existing-session: 连接用户已经启动的浏览器会话
     */
    mode: BrowserRuntimeModeSchema.default("managed-cdp"),
    /** 是否无头模式（默认 false，仅 managed-cdp 模式生效） */
    headless: z.boolean().default(false),
    /**
     * CDP 连接地址。
     * - remote-cdp / existing-session: 必填
     * - managed-cdp: 可选；未提供时由 cdpHost + cdpPort 推导
     */
    cdpUrl: z.string().optional(),
    /** 本地 managed-cdp 的 CDP host（默认 127.0.0.1） */
    cdpHost: z.string().default("127.0.0.1"),
    /** 本地 managed-cdp 的 CDP port（默认 9222） */
    cdpPort: z.number().int().min(1).max(65_535).default(9222),
    /** 浏览器 channel（默认 "chrome"，仅 managed-cdp 模式生效） */
    channel: BrowserChannelSchema.default("chrome"),
    /** 自定义浏览器可执行文件路径（设置后 channel 被忽略，仅 managed-cdp 模式） */
    executablePath: z.string().optional(),
    /** 浏览器持久 profile 目录（managed-cdp 推荐配置） */
    userDataDir: z.string().optional(),
    /** 浏览器额外启动参数（仅 managed-cdp 模式） */
    args: z.array(z.string()).optional(),
    /** Session 持久化目录（默认 ~/.roll-agent/browser/sessions） */
    sessionsDir: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    if (
      (config.mode === "remote-cdp" || config.mode === "existing-session") &&
      config.cdpUrl === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cdpUrl"],
        message: `${config.mode} 模式必须提供 cdpUrl`,
      });
    }
  });

export type BrowserRuntimeConfig = z.infer<typeof BrowserRuntimeConfigSchema>;

// ========== Browser 运行状态 ==========

export const BROWSER_LOGIN_STATE_SOURCES = ["snapshot", "profile", "none", "unknown"] as const;
export const BrowserLoginStateSourceSchema = z.enum(BROWSER_LOGIN_STATE_SOURCES);
export type BrowserLoginStateSource = z.infer<typeof BrowserLoginStateSourceSchema>;

export const BrowserSessionInfoSchema = z.object({
  platform: PlatformSchema,
  pagesOpen: z.number(),
  currentUrl: z.string().optional(),
  /**
   * 登录态布尔判断。
   * - true/false: 当前模式下可可靠判断
   * - null: 当前模式下无法仅靠 commander 可靠判断（如 persistent profile）
   */
  hasLoginState: z.boolean().nullable(),
  /**
   * 登录态判定来源：
   * - snapshot: 基于 sidecar cookies/localStorage 快照判断
   * - profile: 使用持久 profile，但 commander 无法可靠断言是否已登录
   * - none: 当前模式下可判断且未检测到登录态
   * - unknown: 暂无法判断
   */
  loginStateSource: BrowserLoginStateSourceSchema,
});

export type BrowserSessionInfo = z.infer<typeof BrowserSessionInfoSchema>;

export const BrowserStatusSchema = z.object({
  running: z.boolean(),
  headless: z.boolean(),
  mode: BrowserRuntimeModeSchema,
  activeSessions: z.array(BrowserSessionInfoSchema),
});

export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;

export const BrowserPageInfoSchema = z.object({
  pageId: z.string(),
  url: z.string(),
  title: z.string(),
  boundPlatform: PlatformSchema.nullable(),
  detectedPlatform: PlatformSchema.nullable(),
  isSelectedForPlatform: z.boolean(),
});

export type BrowserPageInfo = z.infer<typeof BrowserPageInfoSchema>;

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
