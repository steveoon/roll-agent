import type { AgentContext } from "@roll-agent/sdk";
import { defineTool } from "@roll-agent/sdk";
import type { BrowserPageInfo, Page } from "@roll-agent/browser";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { z } from "zod";
import { randomDelay } from "../pages/zhipin/anti-detection.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import {
  findZhipinSidebarSectionLink,
  isZhipinChatSurfaceOpen,
  waitForZhipinChatSurface,
} from "../pages/zhipin/sidebar-navigation.ts";
import { toAttachedPageInfo } from "../page-info.ts";
import { getContextManager } from "../runtime-holder.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  alreadyOnChat: z.boolean(),
  usedSidebarClick: z.boolean(),
  chatReady: z.boolean(),
  page: BrowserPageInfoSchema.optional(),
  error: z.string().optional(),
});

type VisualActivitySessionLike = Pick<
  VisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail"
>;
type PageLocator = ReturnType<Page["locator"]>;

type ZhipinOpenChatPageDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly findZhipinSidebarSectionLink: typeof findZhipinSidebarSectionLink;
  readonly isZhipinChatSurfaceOpen: typeof isZhipinChatSurfaceOpen;
  readonly waitForZhipinChatSurface: typeof waitForZhipinChatSurface;
  readonly moveVisualCursorToLocator: typeof moveVisualCursorToLocator;
  readonly showVisualClickOnLocator: typeof showVisualClickOnLocator;
  readonly randomDelay: typeof randomDelay;
  readonly toAttachedPageInfo: typeof toAttachedPageInfo;
  readonly createVisualActivitySession: (page: Page) => VisualActivitySessionLike;
};

let zhipinOpenChatPageDepsOverride: Partial<ZhipinOpenChatPageDeps> | undefined;

function getZhipinOpenChatPageDeps(): ZhipinOpenChatPageDeps {
  return {
    getContextManager,
    findZhipinSidebarSectionLink,
    isZhipinChatSurfaceOpen,
    waitForZhipinChatSurface,
    moveVisualCursorToLocator,
    showVisualClickOnLocator,
    randomDelay,
    toAttachedPageInfo,
    createVisualActivitySession: (page) => new VisualActivitySession(page),
    ...zhipinOpenChatPageDepsOverride,
  };
}

export function setZhipinOpenChatPageDepsForTests(
  override: Partial<ZhipinOpenChatPageDeps> | undefined,
): void {
  zhipinOpenChatPageDepsOverride = override;
}

async function buildPageInfo(
  ctxManager: ReturnType<typeof getContextManager>,
  deps: ZhipinOpenChatPageDeps,
  page: Page,
): Promise<BrowserPageInfo> {
  return (await deps.toAttachedPageInfo(ctxManager, page)) satisfies BrowserPageInfo;
}

async function failOpenChat(
  ctxManager: ReturnType<typeof getContextManager>,
  deps: ZhipinOpenChatPageDeps,
  session: VisualActivitySessionLike,
  page: Page,
  error: string,
  options: {
    readonly alreadyOnChat: boolean;
    readonly usedSidebarClick: boolean;
    readonly chatReady: boolean;
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
  deps: ZhipinOpenChatPageDeps,
  link: PageLocator,
  logger: AgentContext["logger"],
): Promise<void> {
  await link.scrollIntoViewIfNeeded();
  await deps.moveVisualCursorToLocator(page, link, { durationMs: 110, settleMs: 30 });
  await link.hover();
  await deps.randomDelay(page, 100, 180);
  await deps.showVisualClickOnLocator(page, link, { pulseDurationMs: 180 });
  await link.click();
  logger.info("Clicked Boss sidebar nav: 沟通");
}

export const zhipinOpenChatPage = defineTool({
  name: "zhipin_open_chat_page",
  description: "通过点击 Boss 左侧导航切换回「沟通」页，避免让编排器依赖站内 URL 猜测。",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    const deps = getZhipinOpenChatPageDeps();
    const ctxManager = deps.getContextManager();

    ctx.logger.info("Opening Boss chat page via sidebar navigation");

    const page = await ctxManager.getPage("zhipin");
    await page.bringToFront().catch(() => {});
    const session = deps.createVisualActivitySession(page);
    const beginLabel = "正在切换到沟通页";

    await session.begin(beginLabel);
    await session.highlightSelector(ZHIPIN_SELECTORS.nav.sidebar, {
      label: beginLabel,
      padding: 10,
    });

    if (await deps.isZhipinChatSurfaceOpen(page)) {
      await session.succeed("已在沟通页");
      return {
        success: true,
        alreadyOnChat: true,
        usedSidebarClick: false,
        chatReady: true,
        page: await buildPageInfo(ctxManager, deps, page),
      };
    }

    const chatLink = await deps.findZhipinSidebarSectionLink(page, "chat");
    if (!chatLink) {
      return await failOpenChat(ctxManager, deps, session, page, "未找到沟通导航", {
        alreadyOnChat: false,
        usedSidebarClick: false,
        chatReady: false,
      });
    }

    try {
      await clickSidebarLink(page, deps, chatLink, ctx.logger);
    } catch (error) {
      return await failOpenChat(
        ctxManager,
        deps,
        session,
        page,
        error instanceof Error ? error.message : "点击沟通导航失败",
        {
          alreadyOnChat: false,
          usedSidebarClick: true,
          chatReady: false,
        },
      );
    }

    const chatReady = await deps.waitForZhipinChatSurface(page);
    if (!chatReady) {
      return await failOpenChat(ctxManager, deps, session, page, "沟通页未就绪", {
        alreadyOnChat: false,
        usedSidebarClick: true,
        chatReady: false,
      });
    }

    await session.succeed("已切换到沟通页");
    return {
      success: true,
      alreadyOnChat: false,
      usedSidebarClick: true,
      chatReady: true,
      page: await buildPageInfo(ctxManager, deps, page),
    };
  },
});
