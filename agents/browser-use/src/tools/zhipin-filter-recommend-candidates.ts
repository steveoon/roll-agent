import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  ZHIPIN_RECOMMEND_ACTIVITY_VALUES,
  ZHIPIN_RECOMMEND_FILTER_APPLY_MODE_VALUES,
  ZHIPIN_RECOMMEND_FILTER_STATUS_VALUES,
  ZHIPIN_RECOMMEND_GENDER_VALUES,
  getZhipinRecommendFilterOptionField,
  type ZhipinRecommendActivity,
  type ZhipinRecommendFilterApplyMode,
  type ZhipinRecommendFilterApplyResult,
  type ZhipinRecommendFilterOptionFieldKey,
  type ZhipinRecommendFilterOptionSelection,
  type ZhipinRecommendFilterRequest,
  type ZhipinRecommendGender,
} from "../pages/zhipin/recommend-filter.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import { maybeBringToFront } from "../browser-foreground.ts";

const RequestedSchema = z.object({
  applyMode: z.enum(ZHIPIN_RECOMMEND_FILTER_APPLY_MODE_VALUES),
  ageMin: z.number().int().min(16).optional(),
  ageMax: z.number().int().min(16).optional(),
  location: z
    .object({
      city: z.string(),
      district: z.string().optional(),
    })
    .optional(),
  optionSelections: z.array(
    z.object({
      fieldKey: z.string(),
      label: z.string(),
      values: z.array(z.string()),
      selection: z.enum(["single", "multi"]),
      clearValue: z.string(),
    }),
  ),
});

const AppliedSchema = z.object({
  ageMin: z.number().optional(),
  ageMax: z.number().optional(),
  location: z
    .object({
      city: z.string(),
      district: z.string().optional(),
    })
    .optional(),
  optionSelections: z.array(
    z.object({
      fieldKey: z.string(),
      label: z.string(),
      values: z.array(z.string()),
    }),
  ),
  gender: z.string().optional(),
  activity: z.string().optional(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  status: z.enum(ZHIPIN_RECOMMEND_FILTER_STATUS_VALUES),
  requested: RequestedSchema,
  applied: AppliedSchema.optional(),
  filterButtonText: z.string().optional(),
  error: z.string().optional(),
});

const nonEmptyOptionLabel = z.string().min(1);
const multiOptionLabels = z.array(nonEmptyOptionLabel).min(1);

const InputSchema = z
  .object({
    applyMode: z
      .enum(ZHIPIN_RECOMMEND_FILTER_APPLY_MODE_VALUES)
      .optional()
      .describe("筛选应用模式：patch 只修改显式传入字段；replace 先点击清除再设置显式传入字段"),
    ageMin: z
      .number()
      .int()
      .min(16)
      .optional()
      .describe("年龄下限；标准模式未传则不修改，空输入/旧字段兼容模式默认重置为 16"),
    ageMax: z
      .number()
      .int()
      .min(16)
      .optional()
      .describe("年龄上限；标准模式未传则不修改，旧字段兼容模式未传表示不限"),
    locationCity: nonEmptyOptionLabel.optional().describe("地区筛选城市，如：上海或上海市"),
    locationDistrict: nonEmptyOptionLabel
      .optional()
      .describe('地区筛选区级选项，如：浦东新区；传 "不限" 表示城市不限区'),
    gender: z.enum(ZHIPIN_RECOMMEND_GENDER_VALUES).optional().describe("性别筛选：不限、男、女"),
    activity: z
      .enum(ZHIPIN_RECOMMEND_ACTIVITY_VALUES)
      .optional()
      .describe("活跃度[单选]，只支持：不限、刚刚活跃、今日活跃、3日内活跃、本周活跃、本月活跃"),
    major: multiOptionLabels
      .optional()
      .describe('专业筛选，可传多个可见专业选项；传 ["不限"] 表示清空'),
    recentNotView: nonEmptyOptionLabel
      .optional()
      .describe("近期没有看过筛选，如：不限、近14天没有"),
    exchangeResumeWithColleague: nonEmptyOptionLabel
      .optional()
      .describe("是否与同事交换简历筛选，如：不限、近一个月没有"),
    candidateKeywords: multiOptionLabels
      .optional()
      .describe('牛人关键词筛选，可传多个可见关键词；传 ["不限"] 表示清空'),
    school: multiOptionLabels
      .optional()
      .describe('院校筛选，可传多个可见选项；传 ["不限"] 表示清空'),
    switchJobFrequency: nonEmptyOptionLabel
      .optional()
      .describe("跳槽频率[单选]，如：不限、5年少于3份、平均每份工作大于1年"),
    intention: multiOptionLabels
      .optional()
      .describe('求职意向筛选，可传多个选项；传 ["不限"] 表示清空'),
    salary: nonEmptyOptionLabel.optional().describe("薪资待遇[单选]，如：不限、3-5K、5-10K"),
    degree: multiOptionLabels
      .optional()
      .describe('学历要求筛选，可传多个选项；传 ["不限"] 表示清空'),
    experience: multiOptionLabels
      .optional()
      .describe('经验要求筛选，可传多个选项；传 ["不限"] 表示清空'),
    callPhone: nonEmptyOptionLabel.optional().describe("是否可拨打电话筛选，如：不限、可拨打"),
  })
  .refine(
    (input) =>
      input.ageMin === undefined || input.ageMax === undefined || input.ageMin <= input.ageMax,
    {
      path: ["ageMax"],
      message: "ageMax must be greater than or equal to ageMin",
    },
  )
  .refine((input) => input.locationDistrict === undefined || input.locationCity !== undefined, {
    path: ["locationCity"],
    message: "locationCity is required when locationDistrict is provided",
  });

const FILTER_CLICK_PRE_DELAY_MS = 350;
const FILTER_CLICK_PRESS_MS = 130;
const FILTER_CLICK_SETTLE_MS = 600;

type FilterRecommendCandidatesInput = z.input<typeof InputSchema>;
type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "previewMouseMotion" | "succeed" | "fail"
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

function buildOptionSelection(
  fieldKey: ZhipinRecommendFilterOptionFieldKey,
  values: readonly string[],
): ZhipinRecommendFilterOptionSelection {
  const field = getZhipinRecommendFilterOptionField(fieldKey);

  return {
    fieldKey,
    label: field.label,
    values,
    selection: field.selection,
    clearValue: field.clearValue,
  };
}

function hasNewFilterField(input: FilterRecommendCandidatesInput): boolean {
  return (
    input.locationCity !== undefined ||
    input.locationDistrict !== undefined ||
    input.major !== undefined ||
    input.recentNotView !== undefined ||
    input.exchangeResumeWithColleague !== undefined ||
    input.candidateKeywords !== undefined ||
    input.school !== undefined ||
    input.switchJobFrequency !== undefined ||
    input.intention !== undefined ||
    input.salary !== undefined ||
    input.degree !== undefined ||
    input.experience !== undefined ||
    input.callPhone !== undefined
  );
}

function hasLegacyFilterField(input: FilterRecommendCandidatesInput): boolean {
  return (
    input.ageMin !== undefined ||
    input.ageMax !== undefined ||
    input.gender !== undefined ||
    input.activity !== undefined
  );
}

function pushSelection(
  selections: ZhipinRecommendFilterOptionSelection[],
  fieldKey: ZhipinRecommendFilterOptionFieldKey,
  value: string | readonly string[] | undefined,
): void {
  if (value === undefined) return;

  const values = Array.isArray(value) ? value : [value];
  selections.push(buildOptionSelection(fieldKey, values));
}

function buildRequested(input: FilterRecommendCandidatesInput): ZhipinRecommendFilterRequest {
  const optionSelections: ZhipinRecommendFilterOptionSelection[] = [];
  const useLegacyDefaults =
    input.applyMode === undefined && !hasNewFilterField(input) && hasLegacyFilterField(input);

  if (useLegacyDefaults || (!hasNewFilterField(input) && !hasLegacyFilterField(input))) {
    const gender: ZhipinRecommendGender = input.gender ?? "不限";
    const activity: ZhipinRecommendActivity = input.activity ?? "不限";

    optionSelections.push(buildOptionSelection("gender", [gender]));
    optionSelections.push(buildOptionSelection("activity", [activity]));

    return {
      applyMode: "patch",
      ageMin: input.ageMin ?? 16,
      ...(input.ageMax !== undefined ? { ageMax: input.ageMax } : {}),
      optionSelections,
    };
  }

  pushSelection(optionSelections, "gender", input.gender);
  pushSelection(optionSelections, "activity", input.activity);
  pushSelection(optionSelections, "major", input.major);
  pushSelection(optionSelections, "recentNotView", input.recentNotView);
  pushSelection(optionSelections, "exchangeResumeWithColleague", input.exchangeResumeWithColleague);
  pushSelection(optionSelections, "candidateKeywords", input.candidateKeywords);
  pushSelection(optionSelections, "school", input.school);
  pushSelection(optionSelections, "switchJobFrequency", input.switchJobFrequency);
  pushSelection(optionSelections, "intention", input.intention);
  pushSelection(optionSelections, "salary", input.salary);
  pushSelection(optionSelections, "degree", input.degree);
  pushSelection(optionSelections, "experience", input.experience);
  pushSelection(optionSelections, "callPhone", input.callPhone);

  const applyMode: ZhipinRecommendFilterApplyMode = input.applyMode ?? "patch";

  return {
    ...(input.ageMin !== undefined ? { ageMin: input.ageMin } : {}),
    ...(input.ageMax !== undefined ? { ageMax: input.ageMax } : {}),
    ...(input.locationCity !== undefined
      ? {
          location: {
            city: input.locationCity,
            ...(input.locationDistrict !== undefined ? { district: input.locationDistrict } : {}),
          },
        }
      : {}),
    applyMode,
    optionSelections,
  };
}

function toOutputRequested(
  requested: ZhipinRecommendFilterRequest,
): z.infer<typeof RequestedSchema> {
  return {
    applyMode: requested.applyMode,
    ...(requested.ageMin !== undefined ? { ageMin: requested.ageMin } : {}),
    ...(requested.ageMax !== undefined ? { ageMax: requested.ageMax } : {}),
    ...(requested.location !== undefined
      ? {
          location: {
            city: requested.location.city,
            ...(requested.location.district !== undefined
              ? { district: requested.location.district }
              : {}),
          },
        }
      : {}),
    optionSelections: requested.optionSelections.map((selection) => ({
      fieldKey: selection.fieldKey,
      label: selection.label,
      values: [...selection.values],
      selection: selection.selection,
      clearValue: selection.clearValue,
    })),
  };
}

function toOutputApplied(
  applied: ZhipinRecommendFilterApplyResult["applied"],
): z.infer<typeof AppliedSchema> | undefined {
  if (applied === undefined) return undefined;

  return {
    ...(applied.ageMin !== undefined ? { ageMin: applied.ageMin } : {}),
    ...(applied.ageMax !== undefined ? { ageMax: applied.ageMax } : {}),
    ...(applied.location !== undefined
      ? {
          location: {
            city: applied.location.city,
            ...(applied.location.district !== undefined
              ? { district: applied.location.district }
              : {}),
          },
        }
      : {}),
    optionSelections: applied.optionSelections.map((selection) => ({
      fieldKey: selection.fieldKey,
      label: selection.label,
      values: [...selection.values],
    })),
    ...(applied.gender !== undefined ? { gender: applied.gender } : {}),
    ...(applied.activity !== undefined ? { activity: applied.activity } : {}),
  };
}

function toToolOutput(result: ZhipinRecommendFilterApplyResult): z.infer<typeof OutputSchema> {
  const applied = toOutputApplied(result.applied);

  return {
    success: result.status === "applied",
    status: result.status,
    requested: toOutputRequested(result.requested),
    ...(applied !== undefined ? { applied } : {}),
    ...(result.filterButtonText !== undefined ? { filterButtonText: result.filterButtonText } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export const zhipinFilterRecommendCandidates = defineTool({
  name: "zhipin_filter_recommend_candidates",
  description:
    "在 BOSS「推荐牛人」页用 native CDP 设置地区、年龄、性别、活跃度、专业、关键词、薪资、学历、经验等筛选条件并提交。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinFilterRecommendCandidatesDeps();
    const requested = buildRequested(input);
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    ctx.logger.info(
      `Filtering Boss recommend candidates through native CDP: applyMode=${requested.applyMode}, ` +
        `ageMin=${requested.ageMin ?? "unchanged"}, ageMax=${requested.ageMax ?? "unchanged"}, ` +
        `location=${
          requested.location !== undefined
            ? `${requested.location.city}${requested.location.district !== undefined ? `-${requested.location.district}` : ""}`
            : "unchanged"
        }, ` +
        `fields=${requested.optionSelections.map((selection) => selection.fieldKey).join(",")}`,
    );

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await maybeBringToFront(nativePage);

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
        ...(session !== undefined ? { motionObserver: session } : {}),
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
