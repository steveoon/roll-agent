import type { Page } from "@roll-agent/browser";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getCurrentZhipinRecruiterIdentity } from "../pages/zhipin/recruiter-identity.ts";
import { findHeaderScope } from "../pages/zhipin/username.ts";
import { getContextManager } from "../runtime-holder.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  username: z.string(),
  usedSelector: z.string().optional(),
  usedStrategy: z.string().optional(),
  source: z.string().optional(),
  error: z.string().optional(),
});

type ZhipinGetUsernameDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly findHeaderScope: typeof findHeaderScope;
  readonly getCurrentZhipinRecruiterIdentity: typeof getCurrentZhipinRecruiterIdentity;
  readonly createVisualActivitySession: (page: Page) => VisualActivitySession;
};

let zhipinGetUsernameDepsOverride: Partial<ZhipinGetUsernameDeps> | undefined;

function getZhipinGetUsernameDeps(): ZhipinGetUsernameDeps {
  return {
    getContextManager,
    findHeaderScope,
    getCurrentZhipinRecruiterIdentity,
    createVisualActivitySession: (page) => new VisualActivitySession(page),
    ...zhipinGetUsernameDepsOverride,
  };
}

export function setZhipinGetUsernameDepsForTests(
  override: Partial<ZhipinGetUsernameDeps> | undefined,
): void {
  zhipinGetUsernameDepsOverride = override;
}

export const zhipinGetUsername = defineTool({
  name: "zhipin_get_username",
  description: "获取当前登录的招聘者用户名",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Getting zhipin username");
    const deps = getZhipinGetUsernameDeps();
    let session: VisualActivitySession | undefined;

    try {
      const ctxManager = deps.getContextManager();
      const page = await ctxManager.getPage("zhipin");
      session = deps.createVisualActivitySession(page);

      await page.bringToFront().catch(() => {});
      await session.begin("正在识别登录账号");

      const headerScope = await deps.findHeaderScope(page);
      if (headerScope) {
        await session.highlightLocator(headerScope, {
          label: "正在识别登录账号",
          padding: 10,
        });
      }

      const identity = await deps.getCurrentZhipinRecruiterIdentity(page);
      await session.succeed(`已识别账号：${identity.username}`);

      ctx.logger.info(
        `Username: ${identity.username} (strategy: ${identity.strategy}, source: ${identity.source})`,
      );
      return {
        success: true,
        username: identity.username,
        usedSelector: identity.strategy === "css-fallback" ? identity.source : undefined,
        usedStrategy: identity.strategy,
        source: identity.source,
      };
    } catch (error) {
      await session?.fail("获取用户名失败");

      return {
        success: false,
        username: "",
        error: error instanceof Error ? `获取用户名失败：${error.message}` : "获取用户名失败",
      };
    }
  },
});
