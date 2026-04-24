import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  applyRecommendFilter,
  waitForRecommendFilterSurface,
  ZHIPIN_RECOMMEND_ACTIVITY_VALUES,
  ZHIPIN_RECOMMEND_FILTER_STATUS_VALUES,
  ZHIPIN_RECOMMEND_GENDER_VALUES,
  type RecommendTarget,
  type ZhipinRecommendActivity,
  type ZhipinRecommendFilterApplyResult,
  type ZhipinRecommendFilterRequest,
  type ZhipinRecommendGender,
} from "../pages/zhipin/recommend-filter.ts";
import { getRecommendTarget } from "../pages/zhipin/recommend-list.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

const RequestedSchema = z.object({
  ageMin: z.number().int().min(16).optional(),
  ageMax: z.number().int().min(16).optional(),
  gender: z.enum(ZHIPIN_RECOMMEND_GENDER_VALUES),
  activity: z.enum(ZHIPIN_RECOMMEND_ACTIVITY_VALUES),
});

const AppliedSchema = z.object({
  ageMin: z.number().optional(),
  ageMax: z.number().optional(),
  gender: z.string(),
  activity: z.string(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  status: z.enum(ZHIPIN_RECOMMEND_FILTER_STATUS_VALUES),
  requested: RequestedSchema,
  applied: AppliedSchema.optional(),
  filterButtonText: z.string().optional(),
  error: z.string().optional(),
});

const InputSchema = z
  .object({
    ageMin: z.number().int().min(16).optional().describe("年龄下限；未传则重置为 16"),
    ageMax: z.number().int().min(16).optional().describe("年龄上限；未传则重置为不限"),
    gender: z
      .enum(ZHIPIN_RECOMMEND_GENDER_VALUES)
      .default("不限")
      .describe("性别筛选，只支持：不限、男、女"),
    activity: z
      .enum(ZHIPIN_RECOMMEND_ACTIVITY_VALUES)
      .default("不限")
      .describe("活跃度[单选]，只支持：不限、刚刚活跃、今日活跃、3日内活跃、本周活跃、本月活跃"),
  })
  .refine(
    (input) =>
      input.ageMin === undefined || input.ageMax === undefined || input.ageMin <= input.ageMax,
    {
      path: ["ageMax"],
      message: "ageMax must be greater than or equal to ageMin",
    },
  );

type FilterRecommendCandidatesInput = z.input<typeof InputSchema>;
type VisualActivitySessionLike = Pick<
  VisualActivitySession,
  "begin" | "highlightSelector" | "retarget" | "succeed" | "fail"
>;

type ZhipinFilterRecommendCandidatesDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly getRecommendTarget: typeof getRecommendTarget;
  readonly waitForRecommendFilterSurface: typeof waitForRecommendFilterSurface;
  readonly applyRecommendFilter: typeof applyRecommendFilter;
  readonly moveVisualCursorToLocator: typeof moveVisualCursorToLocator;
  readonly showVisualClickOnLocator: typeof showVisualClickOnLocator;
  readonly createVisualActivitySession: (target: RecommendTarget) => VisualActivitySessionLike;
};

let zhipinFilterRecommendCandidatesDepsOverride:
  | Partial<ZhipinFilterRecommendCandidatesDeps>
  | undefined;

function getZhipinFilterRecommendCandidatesDeps(): ZhipinFilterRecommendCandidatesDeps {
  return {
    getContextManager,
    getRecommendTarget,
    waitForRecommendFilterSurface,
    applyRecommendFilter,
    moveVisualCursorToLocator,
    showVisualClickOnLocator,
    createVisualActivitySession: (target) => new VisualActivitySession(target),
    ...zhipinFilterRecommendCandidatesDepsOverride,
  };
}

export function setZhipinFilterRecommendCandidatesDepsForTests(
  override: Partial<ZhipinFilterRecommendCandidatesDeps> | undefined,
): void {
  zhipinFilterRecommendCandidatesDepsOverride = override;
}

function buildRequested(input: FilterRecommendCandidatesInput): ZhipinRecommendFilterRequest {
  const gender: ZhipinRecommendGender = input.gender ?? "不限";
  const activity: ZhipinRecommendActivity = input.activity ?? "不限";

  return {
    ...(input.ageMin !== undefined ? { ageMin: input.ageMin } : {}),
    ...(input.ageMax !== undefined ? { ageMax: input.ageMax } : {}),
    gender,
    activity,
  };
}

function toToolOutput(result: ZhipinRecommendFilterApplyResult): z.infer<typeof OutputSchema> {
  return {
    success: result.status === "applied",
    status: result.status,
    requested: result.requested,
    ...(result.applied !== undefined ? { applied: result.applied } : {}),
    ...(result.filterButtonText !== undefined ? { filterButtonText: result.filterButtonText } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export const zhipinFilterRecommendCandidates = defineTool({
  name: "zhipin_filter_recommend_candidates",
  description: "在 BOSS「推荐牛人」页打开筛选面板，只设置年龄、性别、活跃度[单选] 三个维度并提交。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinFilterRecommendCandidatesDeps();
    const requested = buildRequested(input);

    ctx.logger.info(
      `Filtering Boss recommend candidates: gender=${requested.gender}, ` +
        `activity=${requested.activity}, ageMin=${requested.ageMin ?? "16"}, ` +
        `ageMax=${requested.ageMax ?? "不限"}`,
    );

    const ctxManager = deps.getContextManager();
    const page = await ctxManager.getPage("zhipin");
    await page.bringToFront().catch(() => {});

    let target = deps.getRecommendTarget(page);
    const session = deps.createVisualActivitySession(target);

    await session.begin("正在打开推荐筛选");
    let ready = await deps.waitForRecommendFilterSurface(target);
    if (!ready) {
      target = deps.getRecommendTarget(page);
      await session.retarget(target);
      ready = await deps.waitForRecommendFilterSurface(target, 2_500);
    }

    if (!ready) {
      await session.fail("推荐牛人页未就绪");
      return toToolOutput({
        status: "recommend_not_ready",
        requested,
        error: "推荐牛人页未就绪",
      });
    }

    await session.retarget(target);
    await session.begin("正在设置推荐筛选");
    await session.highlightSelector(ZHIPIN_SELECTORS.recommend.filterButton, {
      label: "正在设置推荐筛选",
      padding: 8,
    });

    const result = await deps.applyRecommendFilter(page, target, requested, {
      moveToLocator: deps.moveVisualCursorToLocator,
      showClickOnLocator: deps.showVisualClickOnLocator,
    });
    if (result.status === "applied") {
      await session.succeed("已应用推荐筛选");
    } else {
      await session.fail(result.error ?? result.status);
    }

    return toToolOutput(result);
  },
});
