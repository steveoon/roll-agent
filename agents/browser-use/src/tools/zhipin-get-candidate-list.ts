import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { DYNAMIC_LIST_COLLECTION_STOP_REASONS } from "../pages/shared/dynamic-list-scroller.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { rememberZhipinCandidateRefs } from "../pages/zhipin/semantic-refs.ts";

const CandidateCardSchema = z.object({
  index: z.number(),
  candidateRef: z.string(),
  candidateId: z.string(),
  name: z.string(),
  age: z.string(),
  experience: z.string(),
  education: z.string(),
  workStatus: z.string(),
  company: z.string(),
  currentPosition: z.string(),
  expectedLocation: z.string(),
  expectedPosition: z.string(),
  expectedSalary: z.string(),
  tags: z.array(z.string()),
  buttonText: z.string(),
});

const ScrollStatsSchema = z.object({
  containerLabel: z.string(),
  stepsRequested: z.number(),
  stepsCompleted: z.number(),
  reachedBoundary: z.boolean(),
  stopReason: z.enum(DYNAMIC_LIST_COLLECTION_STOP_REASONS),
  uniqueCount: z.number(),
  duplicateCount: z.number(),
  noNewRounds: z.number(),
  beforeItemCount: z.number(),
  afterItemCount: z.number(),
  beforeScrollHeight: z.number(),
  afterScrollHeight: z.number(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  candidates: z.array(CandidateCardSchema),
  total: z.number(),
  scrollStats: ScrollStatsSchema.optional(),
  error: z.string().optional(),
});

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail"
>;

type ZhipinGetCandidateListDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinGetCandidateListDepsOverride: Partial<ZhipinGetCandidateListDeps> | undefined;

function getZhipinGetCandidateListDeps(): ZhipinGetCandidateListDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinGetCandidateListDepsOverride,
  };
}

export function setZhipinGetCandidateListDepsForTests(
  override: Partial<ZhipinGetCandidateListDeps> | undefined,
): void {
  zhipinGetCandidateListDepsOverride = override;
}

export const zhipinGetCandidateList = defineTool({
  name: "zhipin_get_candidate_list",
  description: "获取推荐列表页的候选人卡片信息",
  input: z.object({
    maxResults: z.number().optional().describe("最多返回条数"),
    autoScroll: z.boolean().default(true).describe("是否自动向下滚动动态列表并合并采集结果"),
    maxScrolls: z.number().int().min(0).max(50).default(4).describe("自动滚动的最大步数"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info("Getting candidate list from recommend page through native backend");

    const deps = getZhipinGetCandidateListDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);

      await session.begin("正在打开推荐列表");
      const listReady = await nativePage.waitForRecommendList();
      if (!listReady) {
        await session.fail("推荐列表未加载");
        return { success: false, candidates: [], total: 0, error: "推荐列表未加载" };
      }

      const readLabel = "正在读取推荐列表";
      await session.begin(readLabel);
      await session.highlightSelector(
        ".candidate-card-wrap, li.card-item, [data-geek], .geek-item",
        {
          label: readLabel,
          padding: 8,
        },
      );

      const collection = await nativePage.readRecommendCandidates({
        autoScroll: input.autoScroll ?? true,
        maxScrolls: input.maxScrolls ?? 4,
        ...(input.maxResults !== undefined ? { targetCount: input.maxResults } : {}),
      });
      const candidates =
        input.maxResults !== undefined
          ? collection.items.slice(0, input.maxResults)
          : [...collection.items];
      const candidateRefTargets = rememberZhipinCandidateRefs(candidates);
      const candidatesWithRefs = candidates.map((candidate, position) => {
        const refTarget = candidateRefTargets[position];
        if (!refTarget) {
          throw new Error(`候选人引用生成失败：position ${String(position)}`);
        }
        return {
          ...candidate,
          candidateRef: refTarget.candidateRef,
        };
      });
      const scrollStats =
        input.autoScroll === false
          ? undefined
          : {
              containerLabel: collection.after.containerLabel,
              stepsRequested: collection.stepsRequested,
              stepsCompleted: collection.stepsCompleted,
              reachedBoundary: collection.reachedBoundary,
              stopReason: collection.stopReason,
              uniqueCount: collection.uniqueCount,
              duplicateCount: collection.duplicateCount,
              noNewRounds: collection.noNewRounds,
              beforeItemCount: collection.before.itemCount,
              afterItemCount: collection.after.itemCount,
              beforeScrollHeight: collection.before.scrollHeight,
              afterScrollHeight: collection.after.scrollHeight,
            };

      await session.succeed(`已读取 ${candidatesWithRefs.length} 位候选人`);
      ctx.logger.info(
        `Found ${candidatesWithRefs.length} candidates in recommend list` +
          (scrollStats ? `, scroll stop: ${scrollStats.stopReason}` : ""),
      );

      return {
        success: true,
        candidates: candidatesWithRefs,
        total: candidatesWithRefs.length,
        ...(scrollStats !== undefined ? { scrollStats } : {}),
      };
    } catch (error) {
      await session?.fail("读取推荐列表失败");
      return {
        success: false,
        candidates: [],
        total: 0,
        error: error instanceof Error ? error.message : "读取推荐列表失败",
      };
    } finally {
      nativePage?.close();
    }
  },
});
