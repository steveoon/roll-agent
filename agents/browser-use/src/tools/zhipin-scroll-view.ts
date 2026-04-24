import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { ensureChatListLoaded } from "../pages/zhipin/chat-navigation.ts";
import { getRecommendTarget, waitForRecommendList } from "../pages/zhipin/recommend-list.ts";
import {
  getZhipinListSurfaceConfig,
  ZHIPIN_LIST_SURFACE_VALUES,
} from "../pages/zhipin/list-surfaces.ts";
import type { ZhipinListSurface } from "../pages/zhipin/list-surfaces.ts";
import {
  scrollDynamicList,
  type DynamicListTarget,
  type ScrollDirection,
} from "../pages/shared/dynamic-list-scroller.ts";
import { getContextManager } from "../runtime-holder.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";

const ScrollSnapshotSchema = z.object({
  containerFound: z.boolean(),
  containerLabel: z.string(),
  scrollTop: z.number(),
  scrollHeight: z.number(),
  clientHeight: z.number(),
  itemCount: z.number(),
  atStart: z.boolean(),
  atEnd: z.boolean(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  surface: z.enum(ZHIPIN_LIST_SURFACE_VALUES),
  direction: z.enum(["up", "down"]),
  stepsRequested: z.number(),
  stepsCompleted: z.number(),
  reachedBoundary: z.boolean(),
  before: ScrollSnapshotSchema,
  after: ScrollSnapshotSchema,
  error: z.string().optional(),
});

async function getSurfaceTarget(
  surface: ZhipinListSurface,
): Promise<{ target: DynamicListTarget; session: VisualActivitySession; ready: boolean }> {
  const ctxManager = getContextManager();
  const page = await ctxManager.getPage("zhipin");

  if (surface === "chat-list") {
    const ready = await ensureChatListLoaded(ctxManager, page);
    const activePage = await ctxManager.getPage("zhipin");
    return { target: activePage, session: new VisualActivitySession(activePage), ready };
  }

  if (surface === "recommend-list") {
    const target = getRecommendTarget(page);
    const ready = await waitForRecommendList(target);
    return { target, session: new VisualActivitySession(target), ready };
  }

  try {
    const config = getZhipinListSurfaceConfig(surface);
    await page.waitForSelector(config.itemSelector, { timeout: 3_000 });
    return { target: page, session: new VisualActivitySession(page), ready: true };
  } catch {
    return { target: page, session: new VisualActivitySession(page), ready: false };
  }
}

export const zhipinScrollView = defineTool({
  name: "zhipin_scroll_view",
  description:
    "滚动 BOSS直聘页面内部动态列表容器。用于调试或显式翻页，支持 chat-list、chat-history、recommend-list。",
  input: z.object({
    surface: z.enum(ZHIPIN_LIST_SURFACE_VALUES).describe("要滚动的页面区域"),
    direction: z.enum(["up", "down"]).optional().describe("滚动方向；不传则使用该区域默认方向"),
    steps: z.number().int().min(1).max(20).default(1).describe("滚动步数"),
    distance: z.number().int().positive().optional().describe("每步滚动像素；不传则按容器高度估算"),
    settleMs: z.number().int().min(0).max(5_000).default(700).describe("每步后等待 DOM 更新的毫秒数"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const config = getZhipinListSurfaceConfig(input.surface);
    const direction: ScrollDirection = input.direction ?? config.defaultDirection;
    const steps = input.steps ?? 1;
    const settleMs = input.settleMs ?? 700;
    const { target, session, ready } = await getSurfaceTarget(input.surface);
    const label = `正在滚动 ${input.surface}`;

    await session.begin(label);
    await session.highlightSelector(config.highlightSelector, { label, padding: 8 });

    if (!ready) {
      await session.fail("列表未加载");
      const emptySnapshot = {
        containerFound: false,
        containerLabel: "",
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        itemCount: 0,
        atStart: true,
        atEnd: true,
      };
      return {
        success: false,
        surface: input.surface,
        direction,
        stepsRequested: steps,
        stepsCompleted: 0,
        reachedBoundary: true,
        before: emptySnapshot,
        after: emptySnapshot,
        error: "列表未加载",
      };
    }

    try {
      const result = await scrollDynamicList(target, config, {
        direction,
        steps,
        settleMs,
        ...(input.distance !== undefined ? { distance: input.distance } : {}),
      });

      await session.succeed(`已滚动 ${result.stepsCompleted}/${result.stepsRequested} 步`);
      ctx.logger.info(
        `Scrolled ${input.surface}: ${result.stepsCompleted}/${result.stepsRequested}, items ${result.before.itemCount} -> ${result.after.itemCount}`,
      );

      return {
        success: result.success,
        surface: input.surface,
        direction: result.direction,
        stepsRequested: result.stepsRequested,
        stepsCompleted: result.stepsCompleted,
        reachedBoundary: result.reachedBoundary,
        before: result.before,
        after: result.after,
      };
    } catch (error) {
      await session.fail("滚动失败");
      throw error;
    }
  },
});
