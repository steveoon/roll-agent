import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  ZHIPIN_RECOMMEND_ACTIVITY_VALUES,
  ZHIPIN_RECOMMEND_FILTER_STATUS_VALUES,
  ZHIPIN_RECOMMEND_GENDER_VALUES,
  type ZhipinRecommendActivity,
  type ZhipinRecommendFilterApplyResult,
  type ZhipinRecommendFilterRequest,
  type ZhipinRecommendGender,
} from "../pages/zhipin/recommend-filter.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";

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

const FILTER_CLICK_PRE_DELAY_MS = 350;
const FILTER_CLICK_PRESS_MS = 130;
const FILTER_CLICK_SETTLE_MS = 600;

type FilterRecommendCandidatesInput = z.input<typeof InputSchema>;
type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "highlightPoint" | "succeed" | "fail"
>;

type ZhipinFilterRecommendCandidatesDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinFilterRecommendCandidatesDepsOverride:
  | Partial<ZhipinFilterRecommendCandidatesDeps>
  | undefined;

function getZhipinFilterRecommendCandidatesDeps(): ZhipinFilterRecommendCandidatesDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
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
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    ctx.logger.info(
      `Filtering Boss recommend candidates through native CDP: gender=${requested.gender}, ` +
        `activity=${requested.activity}, ageMin=${requested.ageMin ?? "16"}, ` +
        `ageMax=${requested.ageMax ?? "不限"}`,
    );

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await nativePage.bringToFront().catch(() => {});

      await session.begin("正在打开推荐筛选");
      const ready = await nativePage.waitForRecommendList(3_000);
      if (!ready) {
        await session.fail("推荐牛人页未就绪");
        return toToolOutput({
          status: "recommend_not_ready",
          requested,
          error: "推荐牛人页未就绪",
        });
      }

      await session.begin("正在设置推荐筛选");
      await session.highlightSelector(ZHIPIN_SELECTORS.recommend.filterButton, {
        label: "正在设置推荐筛选",
        padding: 8,
      });

      const result = await nativePage.applyRecommendFilter(requested, {
        preClickDelayMs: FILTER_CLICK_PRE_DELAY_MS,
        pressDurationMs: FILTER_CLICK_PRESS_MS,
        settleMs: FILTER_CLICK_SETTLE_MS,
        onTargetResolved: async (target) => {
          await session?.highlightPoint(target.x, target.y);
        },
      });
      if (result.status === "applied") {
        await session.succeed("已应用推荐筛选");
      } else {
        await session.fail(result.error ?? result.status);
      }

      return toToolOutput(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "推荐筛选失败";
      await session?.fail(message);
      return toToolOutput({
        status: "error",
        requested,
        error: message,
      });
    } finally {
      nativePage?.close();
    }
  },
});
