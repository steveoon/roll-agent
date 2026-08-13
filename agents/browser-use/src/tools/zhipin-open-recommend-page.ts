import type { BrowserContextManager, BrowserPageInfo } from "@roll-agent/browser";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import { toNativePageInfo } from "../page-info.ts";
import { getContextManager } from "../runtime-holder.ts";
import { maybeBringToFront } from "../browser-foreground.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  alreadyOnRecommend: z.boolean(),
  usedSidebarClick: z.boolean(),
  recommendReady: z.boolean(),
  page: BrowserPageInfoSchema.optional(),
  error: z.string().optional(),
});

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "previewMouseMotion" | "succeed" | "fail"
>;

type ZhipinOpenRecommendPageDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinOpenRecommendPageDepsOverride: Partial<ZhipinOpenRecommendPageDeps> | undefined;

function getZhipinOpenRecommendPageDeps(): ZhipinOpenRecommendPageDeps {
  return {
    getContextManager,
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinOpenRecommendPageDepsOverride,
  };
}

export function setZhipinOpenRecommendPageDepsForTests(
  override: Partial<ZhipinOpenRecommendPageDeps> | undefined,
): void {
  zhipinOpenRecommendPageDepsOverride = override;
}

async function buildPageInfo(
  ctxManager: BrowserContextManager,
  nativePage: ZhipinNativePagePort,
): Promise<BrowserPageInfo> {
  return toNativePageInfo(ctxManager, await nativePage.inspectPage());
}

export const zhipinOpenRecommendPage = defineTool({
  name: "zhipin_open_recommend_page",
  description: "通过点击 Boss 左侧导航切换到「推荐牛人」页，避免让编排器依赖站内 URL 猜测。",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    const deps = getZhipinOpenRecommendPageDeps();
    const ctxManager = deps.getContextManager();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    ctx.logger.info("Opening Boss recommend page via native sidebar navigation");

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await maybeBringToFront(nativePage);

      const beginLabel = "正在切换到推荐牛人页";
      await session.begin(beginLabel);
      await session.highlightSelector(ZHIPIN_SELECTORS.nav.sidebar, {
        label: beginLabel,
        padding: 10,
      });

      if (await nativePage.isRecommendSurfaceOpen()) {
        await session.succeed("已在推荐牛人页");
        return {
          success: true,
          alreadyOnRecommend: true,
          usedSidebarClick: false,
          recommendReady: true,
          page: await buildPageInfo(ctxManager, nativePage),
        };
      }

      const clicked = await nativePage.clickSidebarSection("recommend", {
        ...(session !== undefined ? { motionObserver: session } : {}),
      });
      if (!clicked) {
        await session.fail("未找到推荐牛人导航");
        return {
          success: false,
          alreadyOnRecommend: false,
          usedSidebarClick: false,
          recommendReady: false,
          page: await buildPageInfo(ctxManager, nativePage),
          error: "未找到推荐牛人导航",
        };
      }

      ctx.logger.info("Clicked Boss sidebar nav: 推荐牛人");
      const recommendReady = await nativePage.waitForRecommendSurface();
      if (!recommendReady) {
        await session.fail("推荐牛人页未就绪");
        return {
          success: false,
          alreadyOnRecommend: false,
          usedSidebarClick: true,
          recommendReady: false,
          page: await buildPageInfo(ctxManager, nativePage),
          error: "推荐牛人页未就绪",
        };
      }

      await session.succeed("已切换到推荐牛人页");
      return {
        success: true,
        alreadyOnRecommend: false,
        usedSidebarClick: true,
        recommendReady: true,
        page: await buildPageInfo(ctxManager, nativePage),
      };
    } catch (error) {
      rethrowStructuredToolError(error);
      await session?.fail("切换推荐牛人页失败");
      return {
        success: false,
        alreadyOnRecommend: false,
        usedSidebarClick: false,
        recommendReady: false,
        error: error instanceof Error ? error.message : "切换推荐牛人页失败",
      };
    } finally {
      nativePage?.close();
    }
  },
});
