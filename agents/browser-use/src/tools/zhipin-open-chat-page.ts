import type { BrowserContextManager, BrowserPageInfo } from "@roll-agent/browser";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import { toNativePageInfo } from "../page-info.ts";
import { getContextManager } from "../runtime-holder.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  alreadyOnChat: z.boolean(),
  usedSidebarClick: z.boolean(),
  chatReady: z.boolean(),
  page: BrowserPageInfoSchema.optional(),
  error: z.string().optional(),
});

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail"
> & {
  readonly highlightPoint?: NativeVisualActivitySession["highlightPoint"];
};

type ZhipinOpenChatPageDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinOpenChatPageDepsOverride: Partial<ZhipinOpenChatPageDeps> | undefined;

function getZhipinOpenChatPageDeps(): ZhipinOpenChatPageDeps {
  return {
    getContextManager,
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinOpenChatPageDepsOverride,
  };
}

export function setZhipinOpenChatPageDepsForTests(
  override: Partial<ZhipinOpenChatPageDeps> | undefined,
): void {
  zhipinOpenChatPageDepsOverride = override;
}

async function buildPageInfo(
  ctxManager: BrowserContextManager,
  nativePage: ZhipinNativePagePort,
): Promise<BrowserPageInfo> {
  return toNativePageInfo(ctxManager, await nativePage.inspectPage());
}

export const zhipinOpenChatPage = defineTool({
  name: "zhipin_open_chat_page",
  description: "通过点击 Boss 左侧导航切换回「沟通」页，避免让编排器依赖站内 URL 猜测。",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    const deps = getZhipinOpenChatPageDeps();
    const ctxManager = deps.getContextManager();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    ctx.logger.info("Opening Boss chat page via native sidebar navigation");

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await nativePage.bringToFront().catch(() => {});

      const beginLabel = "正在切换到沟通页";
      await session.begin(beginLabel);
      await session.highlightSelector(ZHIPIN_SELECTORS.nav.sidebar, {
        label: beginLabel,
        padding: 10,
      });

      if (await nativePage.isChatSurfaceOpen()) {
        await session.succeed("已在沟通页");
        return {
          success: true,
          alreadyOnChat: true,
          usedSidebarClick: false,
          chatReady: true,
          page: await buildPageInfo(ctxManager, nativePage),
        };
      }

      const clicked = await nativePage.clickSidebarSection("chat", {
        onTargetResolved: async (target) => {
          await session?.highlightPoint?.(target.x, target.y);
        },
      });
      if (!clicked) {
        await session.fail("未找到沟通导航");
        return {
          success: false,
          alreadyOnChat: false,
          usedSidebarClick: false,
          chatReady: false,
          page: await buildPageInfo(ctxManager, nativePage),
          error: "未找到沟通导航",
        };
      }

      ctx.logger.info("Clicked Boss sidebar nav: 沟通");
      const chatReady = await nativePage.waitForChatSurface();
      if (!chatReady) {
        await session.fail("沟通页未就绪");
        return {
          success: false,
          alreadyOnChat: false,
          usedSidebarClick: true,
          chatReady: false,
          page: await buildPageInfo(ctxManager, nativePage),
          error: "沟通页未就绪",
        };
      }

      await session.succeed("已切换到沟通页");
      return {
        success: true,
        alreadyOnChat: false,
        usedSidebarClick: true,
        chatReady: true,
        page: await buildPageInfo(ctxManager, nativePage),
      };
    } catch (error) {
      await session?.fail("切换沟通页失败");
      return {
        success: false,
        alreadyOnChat: false,
        usedSidebarClick: false,
        chatReady: false,
        error: error instanceof Error ? error.message : "切换沟通页失败",
      };
    } finally {
      nativePage?.close();
    }
  },
});
