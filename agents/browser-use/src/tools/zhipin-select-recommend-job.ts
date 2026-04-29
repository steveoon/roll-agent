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
  jobValue: z.string().optional(),
  jobName: z.string().optional(),
  index: z.number().optional(),
  searchKeyword: z.string().optional(),
  useSearch: z.boolean().optional(),
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
  })
  .refine(
    (input) =>
      input.jobValue !== undefined || input.jobName !== undefined || input.index !== undefined,
    {
      path: ["jobValue"],
      message: "jobValue、jobName、index 至少需要提供一个",
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
  return {
    ...(input.jobValue !== undefined ? { jobValue: input.jobValue } : {}),
    ...(input.jobName !== undefined ? { jobName: input.jobName } : {}),
    ...(input.index !== undefined ? { index: input.index } : {}),
    ...(input.searchKeyword !== undefined ? { searchKeyword: input.searchKeyword } : {}),
    useSearch: input.useSearch ?? true,
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
    "在 BOSS「推荐牛人」页切换顶部招聘岗位筛选。优先传 jobValue，其次 jobName，index 仅作当前快照兜底。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinSelectRecommendJobDeps();
    const request = buildRequest(input);
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    ctx.logger.info(
      `Selecting Boss recommend job: value=${request.jobValue ?? "N/A"}, ` +
        `name=${request.jobName ?? "N/A"}, index=${request.index ?? "N/A"}`,
    );

    try {
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
        status: "selector_not_found",
        requested: request,
        options: [],
        matchedCount: 0,
        error: message,
      });
    } finally {
      nativePage?.close();
    }
  },
});
