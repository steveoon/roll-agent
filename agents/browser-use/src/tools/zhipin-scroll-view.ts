import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import {
  getZhipinListSurfaceConfig,
  ZHIPIN_LIST_SURFACE_VALUES,
} from "../pages/zhipin/list-surfaces.ts";
import type { ZhipinListSurface } from "../pages/zhipin/list-surfaces.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ScrollDirection } from "../pages/shared/dynamic-list-scroller.ts";

const SCROLL_POSITIONS = ["unknown", "top", "middle", "bottom", "only-page"] as const;

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
  atTop: z.boolean(),
  atBottom: z.boolean(),
  canScrollUp: z.boolean(),
  canScrollDown: z.boolean(),
  position: z.enum(SCROLL_POSITIONS),
  before: ScrollSnapshotSchema,
  after: ScrollSnapshotSchema,
  error: z.string().optional(),
});

type ScrollSnapshot = z.infer<typeof ScrollSnapshotSchema>;
type ScrollPosition = (typeof SCROLL_POSITIONS)[number];

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail"
>;

type ZhipinScrollViewDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinScrollViewDepsOverride: Partial<ZhipinScrollViewDeps> | undefined;

function getZhipinScrollViewDeps(): ZhipinScrollViewDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinScrollViewDepsOverride,
  };
}

export function setZhipinScrollViewDepsForTests(
  override: Partial<ZhipinScrollViewDeps> | undefined,
): void {
  zhipinScrollViewDepsOverride = override;
}

function createEmptySnapshot() {
  return {
    containerFound: false,
    containerLabel: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    itemCount: 0,
    atStart: true,
    atEnd: true,
  };
}

function getScrollPosition(snapshot: ScrollSnapshot): ScrollPosition {
  if (!snapshot.containerFound) return "unknown";
  if (snapshot.atStart && snapshot.atEnd) return "only-page";
  if (snapshot.atStart) return "top";
  if (snapshot.atEnd) return "bottom";
  return "middle";
}

function createBoundaryState(snapshot: ScrollSnapshot) {
  return {
    atTop: snapshot.containerFound && snapshot.atStart,
    atBottom: snapshot.containerFound && snapshot.atEnd,
    canScrollUp: snapshot.containerFound && !snapshot.atStart,
    canScrollDown: snapshot.containerFound && !snapshot.atEnd,
    position: getScrollPosition(snapshot),
  };
}

export const zhipinScrollView = defineTool({
  name: "zhipin_scroll_view",
  description:
    "滚动或检查 BOSS直聘页面内部动态列表容器。用于调试或显式翻页，支持 chat-list、chat-history、recommend-list；steps=0 时只返回当前位置和顶部/底部边界。",
  input: z.object({
    surface: z.enum(ZHIPIN_LIST_SURFACE_VALUES).describe("要滚动的页面区域"),
    direction: z.enum(["up", "down"]).optional().describe("滚动方向；不传则使用该区域默认方向"),
    steps: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(1)
      .describe("滚动步数；传 0 时不滚动，只检查当前列表是否在顶部/底部"),
    distance: z.number().int().positive().optional().describe("每步滚动像素；不传则按容器高度估算"),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(5_000)
      .default(700)
      .describe("每步后等待 DOM 更新的毫秒数"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinScrollViewDeps();
    const config = getZhipinListSurfaceConfig(input.surface);
    const direction: ScrollDirection = input.direction ?? config.defaultDirection;
    const steps = input.steps ?? 1;
    const settleMs = input.settleMs ?? 700;
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    try {
      nativePage = await deps.openNativePagePort({
        requireChatPage: input.surface === "chat-list" || input.surface === "chat-history",
      });
      session = deps.createNativeVisualActivitySession(nativePage);
      const label = `正在滚动 ${input.surface}`;

      await session.begin(label);
      await session.highlightSelector(config.highlightSelector, { label, padding: 8 });

      const result = await nativePage.scrollSurface(input.surface as ZhipinListSurface, {
        direction,
        steps,
        settleMs,
        ...(input.distance !== undefined ? { distance: input.distance } : {}),
      });

      if (!result.success) {
        await session.fail("列表未加载");
        return {
          success: false,
          surface: input.surface,
          direction,
          stepsRequested: steps,
          stepsCompleted: 0,
          reachedBoundary: true,
          ...createBoundaryState(result.after),
          before: result.before,
          after: result.after,
          error: "列表未加载",
        };
      }

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
        ...createBoundaryState(result.after),
        before: result.before,
        after: result.after,
      };
    } catch (error) {
      await session?.fail("滚动失败");
      const emptySnapshot = createEmptySnapshot();
      return {
        success: false,
        surface: input.surface,
        direction,
        stepsRequested: steps,
        stepsCompleted: 0,
        reachedBoundary: true,
        ...createBoundaryState(emptySnapshot),
        before: emptySnapshot,
        after: emptySnapshot,
        error: error instanceof Error ? error.message : "滚动失败",
      };
    } finally {
      nativePage?.close();
    }
  },
});
