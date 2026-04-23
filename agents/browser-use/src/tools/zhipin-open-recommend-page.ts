import type { AgentContext } from "@roll-agent/sdk";
import { defineTool } from "@roll-agent/sdk";
import type { BrowserPageInfo, Page } from "@roll-agent/browser";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { z } from "zod";
import { randomDelay } from "../pages/zhipin/anti-detection.ts";
import { getRecommendTarget } from "../pages/zhipin/recommend-list.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import {
  findZhipinSidebarSectionLink,
  isZhipinRecommendSurfaceOpen,
  waitForZhipinRecommendSurface,
} from "../pages/zhipin/sidebar-navigation.ts";
import { toAttachedPageInfo } from "../page-info.ts";
import { getContextManager } from "../runtime-holder.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  alreadyOnRecommend: z.boolean(),
  usedSidebarClick: z.boolean(),
  recommendReady: z.boolean(),
  page: BrowserPageInfoSchema.optional(),
  error: z.string().optional(),
});

type RecommendTarget = ReturnType<typeof getRecommendTarget>;
type VisualActivitySessionLike = Pick<
  VisualActivitySession,
  "begin" | "highlightSelector" | "retarget" | "succeed" | "fail"
>;
type PageLocator = ReturnType<Page["locator"]>;

type ZhipinOpenRecommendPageDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly getRecommendTarget: typeof getRecommendTarget;
  readonly findZhipinSidebarSectionLink: typeof findZhipinSidebarSectionLink;
  readonly isZhipinRecommendSurfaceOpen: typeof isZhipinRecommendSurfaceOpen;
  readonly waitForZhipinRecommendSurface: typeof waitForZhipinRecommendSurface;
  readonly moveVisualCursorToLocator: typeof moveVisualCursorToLocator;
  readonly showVisualClickOnLocator: typeof showVisualClickOnLocator;
  readonly randomDelay: typeof randomDelay;
  readonly toAttachedPageInfo: typeof toAttachedPageInfo;
  readonly createVisualActivitySession: (
    target: RecommendTarget,
  ) => VisualActivitySessionLike;
};

let zhipinOpenRecommendPageDepsOverride: Partial<ZhipinOpenRecommendPageDeps> | undefined;

function getZhipinOpenRecommendPageDeps(): ZhipinOpenRecommendPageDeps {
  return {
    getContextManager,
    getRecommendTarget,
    findZhipinSidebarSectionLink,
    isZhipinRecommendSurfaceOpen,
    waitForZhipinRecommendSurface,
    moveVisualCursorToLocator,
    showVisualClickOnLocator,
    randomDelay,
    toAttachedPageInfo,
    createVisualActivitySession: (target) => new VisualActivitySession(target),
    ...zhipinOpenRecommendPageDepsOverride,
  };
}

export function setZhipinOpenRecommendPageDepsForTests(
  override: Partial<ZhipinOpenRecommendPageDeps> | undefined,
): void {
  zhipinOpenRecommendPageDepsOverride = override;
}

async function buildPageInfo(
  ctxManager: ReturnType<typeof getContextManager>,
  deps: ZhipinOpenRecommendPageDeps,
  page: Page,
): Promise<BrowserPageInfo> {
  return (await deps.toAttachedPageInfo(ctxManager, page)) satisfies BrowserPageInfo;
}

async function failOpenRecommend(
  ctxManager: ReturnType<typeof getContextManager>,
  deps: ZhipinOpenRecommendPageDeps,
  session: VisualActivitySessionLike,
  page: Page,
  error: string,
  options: {
    readonly alreadyOnRecommend: boolean;
    readonly usedSidebarClick: boolean;
    readonly recommendReady: boolean;
  },
) {
  await session.fail(error);
  return {
    success: false,
    ...options,
    page: await buildPageInfo(ctxManager, deps, page),
    error,
  };
}

async function clickSidebarLink(
  page: Page,
  deps: ZhipinOpenRecommendPageDeps,
  link: PageLocator,
  logger: AgentContext["logger"],
): Promise<void> {
  await link.scrollIntoViewIfNeeded();
  await deps.moveVisualCursorToLocator(page, link, { durationMs: 110, settleMs: 30 });
  await link.hover();
  await deps.randomDelay(page, 100, 180);
  await deps.showVisualClickOnLocator(page, link, { pulseDurationMs: 180 });
  await link.click();
  logger.info("Clicked Boss sidebar nav: 推荐牛人");
}

export const zhipinOpenRecommendPage = defineTool({
  name: "zhipin_open_recommend_page",
  description:
    "通过点击 Boss 左侧导航切换到「推荐牛人」页，避免让编排器依赖站内 URL 猜测。",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    const deps = getZhipinOpenRecommendPageDeps();
    const ctxManager = deps.getContextManager();

    ctx.logger.info("Opening Boss recommend page via sidebar navigation");

    const page = await ctxManager.getPage("zhipin");
    await page.bringToFront().catch(() => {});
    const session = deps.createVisualActivitySession(page);
    const beginLabel = "正在切换到推荐牛人页";

    await session.begin(beginLabel);
    await session.highlightSelector(ZHIPIN_SELECTORS.nav.sidebar, {
      label: beginLabel,
      padding: 10,
    });

    if (deps.isZhipinRecommendSurfaceOpen(page)) {
      await session.retarget(deps.getRecommendTarget(page));
      await session.succeed("已在推荐牛人页");
      return {
        success: true,
        alreadyOnRecommend: true,
        usedSidebarClick: false,
        recommendReady: true,
        page: await buildPageInfo(ctxManager, deps, page),
      };
    }

    const recommendLink = await deps.findZhipinSidebarSectionLink(page, "recommend");
    if (!recommendLink) {
      return await failOpenRecommend(ctxManager, deps, session, page, "未找到推荐牛人导航", {
        alreadyOnRecommend: false,
        usedSidebarClick: false,
        recommendReady: false,
      });
    }

    try {
      await clickSidebarLink(page, deps, recommendLink, ctx.logger);
    } catch (error) {
      return await failOpenRecommend(
        ctxManager,
        deps,
        session,
        page,
        error instanceof Error ? error.message : "点击推荐牛人导航失败",
        {
          alreadyOnRecommend: false,
          usedSidebarClick: true,
          recommendReady: false,
        },
      );
    }

    const recommendReady = await deps.waitForZhipinRecommendSurface(page);
    await session.retarget(deps.getRecommendTarget(page));
    if (!recommendReady) {
      return await failOpenRecommend(
        ctxManager,
        deps,
        session,
        page,
        "推荐牛人页未就绪",
        {
          alreadyOnRecommend: false,
          usedSidebarClick: true,
          recommendReady: false,
        },
      );
    }

    await session.succeed("已切换到推荐牛人页");
    return {
      success: true,
      alreadyOnRecommend: false,
      usedSidebarClick: true,
      recommendReady: true,
      page: await buildPageInfo(ctxManager, deps, page),
    };
  },
});
