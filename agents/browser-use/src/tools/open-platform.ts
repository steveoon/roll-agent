import { defineTool } from "@roll-agent/sdk";
import {
  BrowserActionApprovalSchema,
  BrowserPageInfoSchema,
  PlatformSchema,
} from "@roll-agent/browser";
import { z } from "zod";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import { openPlatformHomeTarget } from "../pages/platform-page.ts";
import { toNativePageInfo } from "../page-info.ts";
import { PLATFORM_HOME } from "../platforms.ts";
import {
  assertBrowserActionAllowed,
  createBrowserActionPolicyOptions,
} from "../browser-security.ts";

const OpenPlatformInputSchema = z.object({
  platform: PlatformSchema.describe("目标平台：`zhipin` 代表 BOSS直聘，`yupao` 代表鱼泡"),
  browserActionApproval: BrowserActionApprovalSchema.optional().describe(
    "当 actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
  ),
});

const OpenPlatformOutputSchema = z.object({
  success: z.boolean(),
  page: BrowserPageInfoSchema,
  reusedExistingTab: z.boolean(),
});

export const openPlatform = defineTool({
  name: "open_platform",
  description: "打开并聚焦招聘平台主页，供用户手动登录或后续执行站内操作。",
  input: OpenPlatformInputSchema,
  output: OpenPlatformOutputSchema,
  execute: async (input, ctx) => {
    const { platform } = input;
    const runtime = getRuntime();
    const ctxManager = getContextManager();
    const targetUrl = PLATFORM_HOME[platform];

    const guard = assertBrowserActionAllowed(ctx, runtime, {
      action: "navigate",
      target: targetUrl,
      url: targetUrl,
      ...(input.browserActionApproval !== undefined
        ? { approval: input.browserActionApproval }
        : {}),
    });
    ctx.logger.info(`Opening platform page for ${platform}`);

    const { page, reusedExistingPage } = await openPlatformHomeTarget(
      runtime,
      platform,
      createBrowserActionPolicyOptions(ctx, runtime, {
        approval: input.browserActionApproval,
        approvedByConfirmation: guard.approvedByConfirmation,
        logActions: false,
      }),
    );
    ctxManager.rememberNativePageSelection(platform, page);

    return {
      success: true,
      page: toNativePageInfo(ctxManager, page),
      reusedExistingTab: reusedExistingPage,
    };
  },
});
