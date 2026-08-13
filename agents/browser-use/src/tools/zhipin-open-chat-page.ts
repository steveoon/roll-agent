import type { BrowserContextManager, BrowserPageInfo } from "@roll-agent/browser";
import { BrowserActionApprovalSchema, BrowserPageInfoSchema } from "@roll-agent/browser";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  ZHIPIN_CHAT_RELOAD_SKIPPED_REASONS,
  type ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import { toNativePageInfo } from "../page-info.ts";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import { assertBrowserActionAllowed } from "../browser-security.ts";
import { maybeBringToFront } from "../browser-foreground.ts";

const InputSchema = z.object({
  forceReload: z
    .boolean()
    .optional()
    .describe(
      "为 true 时对当前沟通页执行 native CDP Page.reload，清空长跑累积的 DOM/SPA 状态，并在 document swap 后继续等待实际聊天列表 DOM；用于长跑 tab 的周期性恢复。",
    ),
  expectedConversationId: z
    .string()
    .min(1)
    .optional()
    .describe("forceReload=true 时可传入；必要时滚动列表，等待该会话重新出现后才返回成功。"),
  browserActionApproval: BrowserActionApprovalSchema.optional().describe(
    "当 actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID（仅 forceReload 时需要）。",
  ),
});

const OutputSchema = z.object({
  success: z.boolean(),
  alreadyOnChat: z.boolean(),
  usedSidebarClick: z.boolean(),
  usedReload: z.boolean(),
  chatReady: z.boolean(),
  reloadSkippedReason: z.enum(ZHIPIN_CHAT_RELOAD_SKIPPED_REASONS).optional(),
  page: BrowserPageInfoSchema.optional(),
  error: z.string().optional(),
});

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "previewMouseMotion" | "succeed" | "fail"
>;

type ZhipinOpenChatPageDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly getRuntime: typeof getRuntime;
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinOpenChatPageDepsOverride: Partial<ZhipinOpenChatPageDeps> | undefined;

function getZhipinOpenChatPageDeps(): ZhipinOpenChatPageDeps {
  return {
    getContextManager,
    getRuntime,
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
  description:
    "通过点击 Boss 左侧导航切换回「沟通」页，避免让编排器依赖站内 URL 猜测；forceReload=true 时对当前沟通页执行 native reload，并等待实际聊天列表 DOM 就绪。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinOpenChatPageDeps();
    const ctxManager = deps.getContextManager();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;
    let usedReload = false;

    ctx.logger.info("Opening Boss chat page via native sidebar navigation");

    try {
      nativePage = await deps.openNativePagePort(
        input.forceReload === true ? { requireChatPage: true } : {},
      );
      session = deps.createNativeVisualActivitySession(nativePage);
      await maybeBringToFront(nativePage);

      if (input.forceReload === true) {
        const reloadTarget = await nativePage.inspectChatReloadTarget();
        if (!reloadTarget.ok) {
          await session.fail("当前不是沟通页");
          return {
            success: false,
            alreadyOnChat: false,
            usedSidebarClick: false,
            usedReload: false,
            chatReady: false,
            reloadSkippedReason: reloadTarget.skippedReason,
            page: await buildPageInfo(ctxManager, nativePage),
            error: reloadTarget.error,
          };
        }
        assertBrowserActionAllowed(ctx, deps.getRuntime(), {
          action: "navigate",
          target: reloadTarget.url,
          url: reloadTarget.url,
          ...(input.browserActionApproval !== undefined
            ? { approval: input.browserActionApproval }
            : {}),
        });
        await session.begin("正在刷新沟通页");
        ctx.logger.info("Reloading Boss chat page via native CDP Page.reload");
        await nativePage.reload({
          url: reloadTarget.url,
          onReloadSent: () => {
            usedReload = true;
          },
        });
        const chatListReady = await nativePage.waitForChatListReady({
          ...(input.expectedConversationId !== undefined
            ? { expectedConversationId: input.expectedConversationId }
            : {}),
        });
        if (!chatListReady) {
          await session.fail("刷新后沟通列表未就绪");
          return {
            success: false,
            alreadyOnChat: false,
            usedSidebarClick: false,
            usedReload,
            chatReady: false,
            page: await buildPageInfo(ctxManager, nativePage),
            error: "刷新后沟通列表未就绪",
          };
        }

        await session.succeed("已刷新沟通页");
        return {
          success: true,
          alreadyOnChat: false,
          usedSidebarClick: false,
          usedReload,
          chatReady: true,
          page: await buildPageInfo(ctxManager, nativePage),
        };
      } else {
        const beginLabel = "正在切换到沟通页";
        await session.begin(beginLabel);
        await session.highlightSelector(ZHIPIN_SELECTORS.nav.sidebar, {
          label: beginLabel,
          padding: 10,
        });
      }

      if (await nativePage.isChatSurfaceOpen()) {
        await session.succeed("已在沟通页");
        return {
          success: true,
          alreadyOnChat: true,
          usedSidebarClick: false,
          usedReload,
          chatReady: true,
          page: await buildPageInfo(ctxManager, nativePage),
        };
      }

      const clicked = await nativePage.clickSidebarSection("chat", {
        ...(session !== undefined ? { motionObserver: session } : {}),
      });
      if (!clicked) {
        await session.fail("未找到沟通导航");
        return {
          success: false,
          alreadyOnChat: false,
          usedSidebarClick: false,
          usedReload,
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
          usedReload,
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
        usedReload,
        chatReady: true,
        page: await buildPageInfo(ctxManager, nativePage),
      };
    } catch (error) {
      rethrowStructuredToolError(error);
      await session?.fail("切换沟通页失败");
      return {
        success: false,
        alreadyOnChat: false,
        usedSidebarClick: false,
        usedReload,
        chatReady: false,
        error: error instanceof Error ? error.message : "切换沟通页失败",
      };
    } finally {
      nativePage?.close();
    }
  },
});
