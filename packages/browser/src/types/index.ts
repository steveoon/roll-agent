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

export const BROWSER_ACTION_POLICIES = ["log", "deny", "confirm"] as const;
export const BrowserActionPolicySchema = z.enum(BROWSER_ACTION_POLICIES);
export type BrowserActionPolicy = z.infer<typeof BrowserActionPolicySchema>;

export const BROWSER_FOREGROUND_POLICIES = ["when-minimized", "always", "never"] as const;
export const BrowserForegroundPolicySchema = z.enum(BROWSER_FOREGROUND_POLICIES);
export type BrowserForegroundPolicy = z.infer<typeof BrowserForegroundPolicySchema>;

export const BrowserActionApprovalSchema = z.object({
  id: z.string().trim().min(1),
});
export type BrowserActionApproval = z.infer<typeof BrowserActionApprovalSchema>;

const BrowserSecurityDomainSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase())
  .refine((value) => !value.includes("/") && !value.includes(":") && !value.endsWith("."), {
    message: "domainAllowlist entries must be bare domain names such as zhipin.com",
  });

export const BrowserSecurityConfigSchema = z.object({
  /** 空数组表示不限制导航域名 */
  domainAllowlist: z.array(BrowserSecurityDomainSchema).default([]),
  /** 页面正文类输出上限，超限截断并返回截断元信息 */
  maxPageContentBytes: z.number().int().positive().default(102_400),
  /** AX snapshot 节点数量上限，供 browser_snapshot 复用 */
  maxSnapshotNodes: z.number().int().positive().default(500),
  /** 浏览器动作策略：log 执行并记录，deny/confirm 返回结构化错误 */
  actionPolicy: BrowserActionPolicySchema.default("log"),
  /** 浏览器前台策略：默认仅在窗口最小化时置前，避免打断用户当前桌面工作 */
  foregroundPolicy: BrowserForegroundPolicySchema.default("when-minimized"),
});

export type BrowserSecurityConfig = z.infer<typeof BrowserSecurityConfigSchema>;

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
    /** 浏览器安全策略，默认宽松兼容现有行为 */
    security: BrowserSecurityConfigSchema.default({}),
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
  truncated: z.boolean().optional(),
  originalBytes: z.number().int().nonnegative().optional(),
  returnedBytes: z.number().int().nonnegative().optional(),
});

export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

// ========== Accessibility Snapshot / Element Ref ==========

export const BrowserElementRefHandleSchema = z.string().regex(/^@e[1-9]\d*$/);
export type BrowserElementRefHandle = z.infer<typeof BrowserElementRefHandleSchema>;

export const BrowserAxPropertyValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type BrowserAxPropertyValue = z.infer<typeof BrowserAxPropertyValueSchema>;

export const BrowserElementRefSchema = z.object({
  ref: BrowserElementRefHandleSchema,
  backendNodeId: z.number().int().positive().optional(),
  frameId: z.string().optional(),
  role: z.string(),
  name: z.string(),
  nth: z.number().int().nonnegative(),
  disabled: z.boolean(),
});
export type BrowserElementRef = z.infer<typeof BrowserElementRefSchema>;

const BrowserAxNodeBaseSchema = z.object({
  ref: BrowserElementRefHandleSchema.optional(),
  role: z.string(),
  name: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  ignored: z.boolean(),
  depth: z.number().int().nonnegative(),
  backendNodeId: z.number().int().positive().optional(),
  frameId: z.string().optional(),
  properties: z.record(BrowserAxPropertyValueSchema).optional(),
});

export type BrowserAxNode = z.infer<typeof BrowserAxNodeBaseSchema> & {
  readonly children?: readonly BrowserAxNode[] | undefined;
};

export const BrowserAxNodeSchema: z.ZodType<BrowserAxNode> = BrowserAxNodeBaseSchema.extend({
  children: z.lazy(() => z.array(BrowserAxNodeSchema)).optional(),
});

export const BrowserAxSnapshotSchema = z.object({
  nodes: z.array(BrowserAxNodeSchema),
  refs: z.array(BrowserElementRefSchema),
  nodeCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  maxNodes: z.number().int().positive(),
  interactiveOnly: z.boolean(),
  maxDepth: z.number().int().nonnegative().optional(),
});
export type BrowserAxSnapshot = z.infer<typeof BrowserAxSnapshotSchema>;

// ========== Wait 策略选项 ==========

export const WaitOptionsSchema = z.object({
  timeout: z.number().default(30_000),
});

export type WaitOptions = z.infer<typeof WaitOptionsSchema>;
