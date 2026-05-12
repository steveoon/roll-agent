import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type {
  NativeRecommendJobOption,
  NativeRecommendJobSelectResult,
  NativeRecommendJobSelectRequest,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import {
  ZHIPIN_RECOMMEND_JOB_REF_PATTERN,
  resolveZhipinRecommendJobRefTarget,
} from "../pages/zhipin/semantic-refs.ts";

const RECOMMEND_JOB_SELECT_STATUS_VALUES = [
  "selected",
  "already_selected",
  "not_found",
  "recommend_not_ready",
  "selector_not_found",
] as const;

const JobOptionSchema = z.object({
  index: z.number(),
  value: z.string(),
  label: z.string(),
  isCurrent: z.boolean(),
});

const RequestedSchema = z.object({
  jobRef: z.string().optional(),
  jobValue: z.string().optional(),
  jobName: z.string().optional(),
  index: z.number().optional(),
  searchKeyword: z.string().optional(),
  useSearch: z.boolean().optional(),
  forceClick: z.boolean().optional(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  status: z.enum(RECOMMEND_JOB_SELECT_STATUS_VALUES),
  requested: RequestedSchema,
  current: JobOptionSchema.optional(),
  selected: JobOptionSchema.optional(),
  options: z.array(JobOptionSchema),
  matchedCount: z.number(),
  error: z.string().optional(),
});

const InputSchema = z
  .object({
    jobRef: z
      .string()
      .regex(ZHIPIN_RECOMMEND_JOB_REF_PATTERN, "jobRef 应类似 @j1")
      .optional()
      .describe("岗位语义引用，如 @j1；来自 zhipin_list_recommend_jobs 输出，优先级最高"),
    jobValue: z
      .string()
      .min(1)
      .optional()
      .describe("岗位下拉 li.job-item 的 value，来自本工具或页面 DOM；最稳定，优先匹配"),
    jobName: z.string().min(1).optional().describe("岗位标题/名称，缺少 jobValue 时用于文本匹配"),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("当前岗位下拉快照里的 index，仅在缺少 jobValue/jobName 时兜底"),
    searchKeyword: z
      .string()
      .min(1)
      .optional()
      .describe("下拉搜索框关键词；不传时用 jobName 作为搜索关键词"),
    useSearch: z.boolean().default(true).describe("初始可见项未命中时是否使用下拉搜索框收敛候选项"),
    forceClick: z
      .boolean()
      .default(false)
      .describe("目标岗位已选中时是否仍点击一次岗位项；默认 false，避免无意义重复点击"),
  })
  .refine(
    (input) =>
      input.jobRef !== undefined ||
      input.jobValue !== undefined ||
      input.jobName !== undefined ||
      input.index !== undefined,
    {
      path: ["jobRef"],
      message: "jobRef、jobValue、jobName、index 至少需要提供一个",
    },
  );

const SELECT_JOB_CLICK_PRE_DELAY_MS = 900;
const SELECT_JOB_CLICK_PRESS_MS = 180;
const SELECT_JOB_CLICK_SETTLE_MS = 1_400;

type SelectRecommendJobInput = z.input<typeof InputSchema>;
type SelectRecommendJobOutput = z.infer<typeof OutputSchema>;

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "previewMouseMotion" | "succeed" | "fail"
>;

type ZhipinSelectRecommendJobDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinSelectRecommendJobDepsOverride: Partial<ZhipinSelectRecommendJobDeps> | undefined;

function getZhipinSelectRecommendJobDeps(): ZhipinSelectRecommendJobDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinSelectRecommendJobDepsOverride,
  };
}

export function setZhipinSelectRecommendJobDepsForTests(
  override: Partial<ZhipinSelectRecommendJobDeps> | undefined,
): void {
  zhipinSelectRecommendJobDepsOverride = override;
}

function buildRequest(input: SelectRecommendJobInput): NativeRecommendJobSelectRequest {
  if (input.jobRef !== undefined) {
    const target = resolveZhipinRecommendJobRefTarget(input.jobRef);
    return {
      jobRef: target.jobRef,
      ...(target.value.length > 0 ? { jobValue: target.value } : {}),
      ...(target.value.length === 0 && target.label.length > 0 ? { jobName: target.label } : {}),
      index: target.index,
      ...(input.searchKeyword !== undefined ? { searchKeyword: input.searchKeyword } : {}),
      useSearch: input.useSearch ?? true,
      forceClick: input.forceClick ?? false,
    };
  }

  return {
    ...(input.jobValue !== undefined ? { jobValue: input.jobValue } : {}),
    ...(input.jobName !== undefined ? { jobName: input.jobName } : {}),
    ...(input.index !== undefined ? { index: input.index } : {}),
    ...(input.searchKeyword !== undefined ? { searchKeyword: input.searchKeyword } : {}),
    useSearch: input.useSearch ?? true,
    forceClick: input.forceClick ?? false,
  };
}

function buildUnresolvedRequest(input: SelectRecommendJobInput): NativeRecommendJobSelectRequest {
  return {
    ...(input.jobRef !== undefined ? { jobRef: input.jobRef } : {}),
    ...(input.jobValue !== undefined ? { jobValue: input.jobValue } : {}),
    ...(input.jobName !== undefined ? { jobName: input.jobName } : {}),
    ...(input.index !== undefined ? { index: input.index } : {}),
    ...(input.searchKeyword !== undefined ? { searchKeyword: input.searchKeyword } : {}),
    useSearch: input.useSearch ?? true,
    forceClick: input.forceClick ?? false,
  };
}

function toMutableOption(option: NativeRecommendJobOption) {
  return {
    index: option.index,
    value: option.value,
    label: option.label,
    isCurrent: option.isCurrent,
  };
}

function toToolOutput(result: NativeRecommendJobSelectResult): SelectRecommendJobOutput {
  return {
    success: result.success,
    status: result.status,
    requested: result.requested,
    ...(result.current !== undefined ? { current: toMutableOption(result.current) } : {}),
    ...(result.selected !== undefined ? { selected: toMutableOption(result.selected) } : {}),
    options: result.options.map(toMutableOption),
    matchedCount: result.matchedCount,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export const zhipinSelectRecommendJob = defineTool({
  name: "zhipin_select_recommend_job",
  description:
    "在 BOSS「推荐牛人」页切换顶部招聘岗位筛选。优先传 jobRef，其次 jobValue，再次 jobName，index 仅作当前快照兜底。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinSelectRecommendJobDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    try {
      const request = buildRequest(input);
      ctx.logger.info(
        `Selecting Boss recommend job: ref=${request.jobRef ?? "N/A"}, ` +
          `value=${request.jobValue ?? "N/A"}, name=${request.jobName ?? "N/A"}, ` +
          `index=${request.index ?? "N/A"}, forceClick=${request.forceClick === true}`,
      );

      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await nativePage.bringToFront().catch(() => {});

      await session.begin("正在选择推荐岗位");
      await session.highlightSelector(".job-selecter-wrap", {
        label: "正在选择推荐岗位",
        padding: 8,
      });

      const result = await nativePage.selectRecommendJob(request, {
        preClickDelayMs: SELECT_JOB_CLICK_PRE_DELAY_MS,
        pressDurationMs: SELECT_JOB_CLICK_PRESS_MS,
        settleMs: SELECT_JOB_CLICK_SETTLE_MS,
        ...(session !== undefined ? { motionObserver: session } : {}),
      });

      if (result.success) {
        await session.succeed(
          result.status === "already_selected" ? "推荐岗位已是目标岗位" : "已选择推荐岗位",
        );
      } else {
        await session.fail(result.error ?? "选择推荐岗位失败");
      }

      return toToolOutput(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "选择推荐岗位失败";
      await session?.fail(message);
      return toToolOutput({
        success: false,
        status: input.jobRef !== undefined ? "not_found" : "selector_not_found",
        requested: buildUnresolvedRequest(input),
        options: [],
        matchedCount: 0,
        error: message,
      });
    } finally {
      nativePage?.close();
    }
  },
});
