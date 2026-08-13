import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type {
  NativeRecommendJobOption,
  NativeRecommendJobListResult,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";
import { rememberZhipinRecommendJobRefs } from "../pages/zhipin/semantic-refs.ts";
import { maybeBringToFront } from "../browser-foreground.ts";

const RECOMMEND_JOB_LIST_STATUS_VALUES = [
  "listed",
  "recommend_not_ready",
  "selector_not_found",
] as const;

const JobOptionSchema = z.object({
  index: z.number(),
  jobRef: z.string().optional(),
  value: z.string(),
  label: z.string(),
  isCurrent: z.boolean(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  status: z.enum(RECOMMEND_JOB_LIST_STATUS_VALUES),
  current: JobOptionSchema.optional(),
  jobs: z.array(JobOptionSchema),
  availableCount: z.number(),
  canSwitch: z.boolean(),
  error: z.string().optional(),
});

type RecommendJobIdentity = Pick<NativeRecommendJobOption, "index" | "value" | "label">;

const LIST_JOB_CLICK_PRE_DELAY_MS = 450;
const LIST_JOB_CLICK_PRESS_MS = 140;
const LIST_JOB_CLICK_SETTLE_MS = 750;

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "previewMouseMotion" | "succeed" | "fail"
>;

type ZhipinListRecommendJobsDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinListRecommendJobsDepsOverride: Partial<ZhipinListRecommendJobsDeps> | undefined;

function getZhipinListRecommendJobsDeps(): ZhipinListRecommendJobsDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinListRecommendJobsDepsOverride,
  };
}

export function setZhipinListRecommendJobsDepsForTests(
  override: Partial<ZhipinListRecommendJobsDeps> | undefined,
): void {
  zhipinListRecommendJobsDepsOverride = override;
}

function toMutableOption(option: NativeRecommendJobOption, jobRef?: string) {
  return {
    index: option.index,
    ...(jobRef !== undefined ? { jobRef } : {}),
    value: option.value,
    label: option.label,
    isCurrent: option.isCurrent,
  };
}

function matchesOption(left: RecommendJobIdentity, right: RecommendJobIdentity): boolean {
  if (left.value.length > 0 && right.value.length > 0) {
    return left.value === right.value;
  }
  return left.index === right.index && left.label === right.label;
}

function toToolOutput(result: NativeRecommendJobListResult): z.infer<typeof OutputSchema> {
  const targets = rememberZhipinRecommendJobRefs(result.options);
  const jobs = result.options.map((option, position) =>
    toMutableOption(option, targets[position]?.jobRef),
  );
  let current: z.infer<typeof JobOptionSchema> | undefined;
  if (result.current !== undefined) {
    const currentOption = result.current;
    current =
      jobs.find((job) => matchesOption(job, currentOption)) ?? toMutableOption(currentOption);
  }

  return {
    success: result.success,
    status: result.status,
    ...(current !== undefined ? { current } : {}),
    jobs,
    availableCount: result.availableCount,
    canSwitch: result.canSwitch,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export const zhipinListRecommendJobs = defineTool({
  name: "zhipin_list_recommend_jobs",
  description:
    "读取 BOSS「推荐牛人」页顶部招聘岗位下拉选项，只读不切换；返回 jobRef/jobValue/current/canSwitch。",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    const deps = getZhipinListRecommendJobsDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    ctx.logger.info("Listing Boss recommend jobs through native CDP");

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await maybeBringToFront(nativePage);

      await session.begin("正在读取推荐岗位");
      await session.highlightSelector(".job-selecter-wrap", {
        label: "正在读取推荐岗位",
        padding: 8,
      });

      const result = await nativePage.listRecommendJobs({
        preClickDelayMs: LIST_JOB_CLICK_PRE_DELAY_MS,
        pressDurationMs: LIST_JOB_CLICK_PRESS_MS,
        settleMs: LIST_JOB_CLICK_SETTLE_MS,
        ...(session !== undefined ? { motionObserver: session } : {}),
      });

      if (result.success) {
        await session.succeed(`已读取 ${result.availableCount} 个推荐岗位`);
      } else {
        await session.fail(result.error ?? "读取推荐岗位失败");
      }

      return toToolOutput(result);
    } catch (error) {
      rethrowStructuredToolError(error);
      const message = error instanceof Error ? error.message : "读取推荐岗位失败";
      await session?.fail(message);
      return toToolOutput({
        success: false,
        status: "selector_not_found",
        options: [],
        availableCount: 0,
        canSwitch: false,
        error: message,
      });
    } finally {
      nativePage?.close();
    }
  },
});
