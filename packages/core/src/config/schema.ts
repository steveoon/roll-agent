import { z } from "zod";

const browserPlatforms = ["zhipin", "yupao"] as const;
const browserRuntimeModes = ["managed-cdp", "remote-cdp", "existing-session"] as const;
const browserChannels = ["chrome", "chromium", "msedge"] as const;
const runtimeApprovalDefaults = ["guarded", "auto", "deny"] as const;
const runtimeApprovalOverrideActions = ["auto", "confirm", "deny"] as const;
const runtimeCompactionStrategies = ["summarize", "truncate"] as const;
export const runtimeThinkingLevels = ["off", "low", "medium", "high"] as const;
export const CHAT_SCREEN_MODES = ["auto", "fullscreen", "inline"] as const;
export const CHAT_THINKING_DISPLAY_MODES = ["collapsed", "expanded"] as const;

const browserProfileColorSchema = z
  .string()
  .trim()
  .regex(/^#[\da-fA-F]{6}$/, "profileColor must be a hex RGB color such as #2563EB")
  .transform((value) => value.toUpperCase());

export const browserWindowBoundsSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const providerConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().optional(),
});

export const llmConfigSchema = z.object({
  defaultProvider: z.string(),
  defaultModel: z.string(),
  providers: z.record(z.string(), providerConfigSchema),
});

export const askConfigSchema = z.object({
  llmModel: z.string().optional(),
  confirmThreshold: z.number().optional(),
});

export const chatScreenModeSchema = z.enum(CHAT_SCREEN_MODES);
export const chatThinkingDisplaySchema = z.enum(CHAT_THINKING_DISPLAY_MODES);

export const chatConfigSchema = z.object({
  screenMode: chatScreenModeSchema.default("auto"),
  /**
   * 已完成思考内容的展示方式：`collapsed` 折叠为一行摘要（默认），
   * `expanded` 始终完整显示。思考进行中始终实时展示，不受此项影响。
   */
  thinkingDisplay: chatThinkingDisplaySchema.default("collapsed"),
});

export const runtimeApprovalConfigSchema = z.object({
  default: z.enum(runtimeApprovalDefaults).default("guarded"),
  overrides: z.record(z.string(), z.enum(runtimeApprovalOverrideActions)).default({}),
});

export const runtimeCompactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  strategy: z.enum(runtimeCompactionStrategies).default("summarize"),
  timeoutMs: z.number().int().min(10_000).max(600_000).default(120_000),
  thinkingLevel: z.enum(runtimeThinkingLevels).optional(),
  maxOutputTokens: z.number().int().min(2_048).max(32_768).default(8_192),
  threshold: z.number().min(0.1).max(0.95).default(0.75),
  keepRecentTurns: z.number().int().min(1).default(4),
  keepRecentTokens: z.number().int().min(1).default(32_000),
});

export const runtimeAgentBootstrapConfigSchema = z.object({
  timeoutMs: z.number().int().min(5_000).max(300_000).default(60_000),
});

export const runtimeShellSessionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxSessions: z.number().int().min(1).max(64).default(8),
  defaultYieldMs: z.number().int().min(250).max(30_000).default(10_000),
  maxOutputTokens: z.number().int().min(256).default(10_000),
});

export const runtimeShellConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoApproveSafe: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(1_000).max(600_000).default(10_000),
  maxTimeoutMs: z.number().int().min(1_000).max(600_000).default(600_000),
  maxCaptureBytes: z.number().int().min(16_384).default(1_048_576),
  maxModelOutputChars: z.number().int().min(1_000).default(16_000),
  session: runtimeShellSessionConfigSchema.default({}),
});

export const runtimeConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  maxSteps: z.number().int().min(1).default(80),
  turnTimeoutMs: z.number().int().min(10_000).default(300_000),
  threadsDir: z.string().default("~/.roll-agent/threads"),
  contextWindow: z.number().int().min(1).optional(),
  thinkingLevel: z.enum(runtimeThinkingLevels).default("medium"),
  approval: runtimeApprovalConfigSchema.default({}),
  compaction: runtimeCompactionConfigSchema.default({}),
  agentBootstrap: runtimeAgentBootstrapConfigSchema.default({}),
  shell: runtimeShellConfigSchema.default({}),
});

export const skillsConfigSchema = z.object({
  /** 额外的 skill 目录（canonical `.agents/skills` 之外的补充来源）。 */
  dirs: z.array(z.string().trim().min(1)).default([]),
});

export const agentsConfigSchema = z.object({
  dataDir: z.string(),
  /** per-agent 环境变量：键为 agent name，值为 key-value 对 */
  env: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

/**
 * npm 安装/更新行为配置（影响 `roll agent install` / `roll update`）。
 *
 * 安全口径：默认走 npm 自身的源（通常官方源），只有用户显式配置 `registry`
 * 才切换镜像源；roll 不做隐式自动 fallback。
 */
export const installConfigSchema = z.object({
  /** 显式 opt-in 的 npm registry（如国内镜像）。未配置时使用 npm 默认源。 */
  registry: z.string().trim().url().optional(),
  /** 透传给 npm 的 `--fetch-retries`，并用于 roll 层整体重试次数。 */
  fetchRetries: z.number().int().min(0).max(10).default(3),
  /** 安装时附加 `--prefer-offline`，默认关闭以避免更新时复用过期 npm 元数据。 */
  preferOffline: z.boolean().default(false),
  /** 单次 npm 安装命令的超时（毫秒）。 */
  networkTimeoutMs: z.number().int().min(10_000).default(120_000),
});

export const browserInstanceConfigSchema = z
  .object({
    platform: z.enum(browserPlatforms).optional(),
    mode: z.enum(browserRuntimeModes).default("managed-cdp"),
    headless: z.boolean().optional(),
    cdpUrl: z.string().optional(),
    cdpHost: z.string().default("127.0.0.1"),
    cdpPort: z.number().int().min(1).max(65_535).optional(),
    channel: z.enum(browserChannels).default("chrome"),
    executablePath: z.string().optional(),
    userDataDir: z.string().trim().min(1),
    sessionsDir: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    profileName: z.string().trim().min(1).optional(),
    profileColor: browserProfileColorSchema.optional(),
    windowBounds: browserWindowBoundsSchema.optional(),
    trackingAgentId: z.string().trim().min(1).optional(),
  })
  .superRefine((instance, ctx) => {
    if (instance.mode === "managed-cdp" && instance.cdpPort === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cdpPort"],
        message: "managed-cdp browser instance requires cdpPort",
      });
    }
    if (
      (instance.mode === "remote-cdp" || instance.mode === "existing-session") &&
      instance.cdpUrl === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cdpUrl"],
        message: `${instance.mode} browser instance requires cdpUrl`,
      });
    }
  });

export const browserConfigSchema = z
  .object({
    defaultInstance: z.string().trim().min(1).optional(),
    instances: z.record(z.string(), browserInstanceConfigSchema).default({}),
  })
  .superRefine((browser, ctx) => {
    const instanceEntries = Object.entries(browser.instances);
    if (
      browser.defaultInstance !== undefined &&
      browser.instances[browser.defaultInstance] === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultInstance"],
        message: `defaultInstance "${browser.defaultInstance}" is not declared in browser.instances`,
      });
    }

    const seenPorts = new Map<number, string>();
    const seenUserDataDirs = new Map<string, string>();
    for (const [id, instance] of instanceEntries) {
      if (instance.cdpPort !== undefined) {
        const existing = seenPorts.get(instance.cdpPort);
        if (existing !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["instances", id, "cdpPort"],
            message: `cdpPort ${String(instance.cdpPort)} is already used by browser instance "${existing}"`,
          });
        } else {
          seenPorts.set(instance.cdpPort, id);
        }
      }

      const existingUserDataDir = seenUserDataDirs.get(instance.userDataDir);
      if (existingUserDataDir !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["instances", id, "userDataDir"],
          message: `userDataDir is already used by browser instance "${existingUserDataDir}"`,
        });
      } else {
        seenUserDataDirs.set(instance.userDataDir, id);
      }
    }
  });

export const rollConfigSchema = z.object({
  llm: llmConfigSchema,
  ask: askConfigSchema,
  chat: chatConfigSchema.default({}),
  runtime: runtimeConfigSchema.default({}),
  skills: skillsConfigSchema.default({}),
  agents: agentsConfigSchema,
  install: installConfigSchema.default({}),
  browser: browserConfigSchema.default({}),
});

export type RollConfig = z.infer<typeof rollConfigSchema>;
export type ChatConfig = z.infer<typeof chatConfigSchema>;
export type ChatScreenMode = z.infer<typeof chatScreenModeSchema>;
export type ChatThinkingDisplay = z.infer<typeof chatThinkingDisplaySchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;
export type RuntimeApprovalConfig = z.infer<typeof runtimeApprovalConfigSchema>;
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
export type InstallConfig = z.infer<typeof installConfigSchema>;
