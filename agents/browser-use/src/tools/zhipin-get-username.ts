import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";
import { pickBestUsername } from "../pages/zhipin/username.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  username: z.string(),
  usedSelector: z.string().optional(),
  usedStrategy: z.string().optional(),
  source: z.string().optional(),
  error: z.string().optional(),
});

type ZhipinGetUsernameDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly pickBestUsername: typeof pickBestUsername;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySession;
};

let zhipinGetUsernameDepsOverride: Partial<ZhipinGetUsernameDeps> | undefined;

function getZhipinGetUsernameDeps(): ZhipinGetUsernameDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    pickBestUsername,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
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
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySession | undefined;

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await session.begin("正在识别登录账号");
      await session.highlightSelector('header, #header, [role="banner"], [role="navigation"]', {
        label: "正在识别登录账号",
        padding: 10,
      });

      const result = deps.pickBestUsername(await nativePage.readUsernameEvidence());
      if (!result.found) {
        throw new Error("未找到用户名，请确认当前页面已登录招聘者账号。");
      }
      await session.succeed(`已识别账号：${result.username}`);

      ctx.logger.info(
        `Username: ${result.username} (strategy: ${result.strategy}, source: ${result.source})`,
      );
      return {
        success: true,
        username: result.username,
        usedSelector: result.strategy === "css-fallback" ? result.source : undefined,
        usedStrategy: result.strategy,
        source: result.source,
      };
    } catch (error) {
      rethrowStructuredToolError(error);
      await session?.fail("获取用户名失败");

      return {
        success: false,
        username: "",
        error: error instanceof Error ? `获取用户名失败：${error.message}` : "获取用户名失败",
      };
    } finally {
      nativePage?.close();
    }
  },
});
