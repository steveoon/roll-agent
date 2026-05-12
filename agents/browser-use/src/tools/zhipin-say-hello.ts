import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  ZHIPIN_CANDIDATE_REF_PATTERN,
  isZhipinCandidateTargetCurrent,
  resolveZhipinCandidateTargets,
  type ZhipinCandidateRefTarget,
} from "../pages/zhipin/semantic-refs.ts";
import { recordZhipinCandidateContactedEvent } from "../recruitment-events/zhipin-events.ts";

const ResultItemSchema = z.object({
  index: z.number(),
  candidateRef: z.string(),
  candidateName: z.string(),
  candidateId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  results: z.array(ResultItemSchema),
  summary: z.object({ total: z.number(), succeeded: z.number(), failed: z.number() }),
});

const SAY_HELLO_BATCH_INTERVAL_MS = [1_400, 1_800, 2_200] as const;
const SAY_HELLO_CLICK_PRE_DELAY_MS = 450;
const SAY_HELLO_CLICK_PRESS_MS = 140;
const SAY_HELLO_CLICK_SETTLE_MS = 750;

const InputSchema = z
  .object({
    indices: z
      .array(z.number().int().min(0))
      .min(1)
      .optional()
      .describe("要打招呼的候选人索引列表"),
    candidateRefs: z
      .array(z.string().regex(ZHIPIN_CANDIDATE_REF_PATTERN, "candidateRef 应类似 @c1"))
      .min(1)
      .optional()
      .describe("要打招呼的候选人语义引用列表，如 @c1；来自 zhipin_get_candidate_list 输出"),
  })
  .refine(
    (input) => (input.indices?.length ?? 0) > 0 || (input.candidateRefs?.length ?? 0) > 0,
    "必须提供 indices 或 candidateRefs",
  );

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "previewMouseMotion" | "succeed" | "fail"
>;

type ZhipinSayHelloDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
  readonly sleep: (ms: number) => Promise<void>;
};

let zhipinSayHelloDepsOverride: Partial<ZhipinSayHelloDeps> | undefined;

function getZhipinSayHelloDeps(): ZhipinSayHelloDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    sleep: async (ms) =>
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    ...zhipinSayHelloDepsOverride,
  };
}

export function setZhipinSayHelloDepsForTests(
  override: Partial<ZhipinSayHelloDeps> | undefined,
): void {
  zhipinSayHelloDepsOverride = override;
}

export const zhipinSayHello = defineTool({
  name: "zhipin_say_hello",
  description: "在推荐列表页对候选人点击「打招呼」按钮（支持批量）",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const candidateTargets = resolveZhipinCandidateTargets(input);
    ctx.logger.info(`Saying hello to ${candidateTargets.length} candidates through native CDP`);

    const deps = getZhipinSayHelloDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);

      await session.begin("正在打开推荐列表");
      const listReady = await nativePage.waitForRecommendList();
      if (!listReady) {
        await session.fail("推荐列表未加载");
        const results = candidateTargets.map((target) => ({
          index: target.index,
          candidateRef: target.candidateRef,
          candidateName: "",
          candidateId: "",
          success: false,
          error: "推荐列表未加载",
        }));
        return {
          success: false,
          results,
          summary: { total: results.length, succeeded: 0, failed: results.length },
        };
      }

      const batchLabel = candidateTargets.length > 1 ? "正在批量打招呼" : "正在打招呼";
      await session.begin(batchLabel);
      await session.highlightSelector(".candidate-card-wrap, [data-geek], .geek-item", {
        label: batchLabel,
        padding: 8,
      });

      const results: Array<z.infer<typeof ResultItemSchema>> = [];
      for (const [position, target] of candidateTargets.entries()) {
        if (position > 0) {
          const interval =
            SAY_HELLO_BATCH_INTERVAL_MS[(position - 1) % SAY_HELLO_BATCH_INTERVAL_MS.length] ??
            SAY_HELLO_BATCH_INTERVAL_MS[0];
          await deps.sleep(interval);
        }

        if (hasStableCandidateIdentity(target)) {
          const currentCandidate = await nativePage.inspectRecommendCard(target.index);
          if (!isZhipinCandidateTargetCurrent(target, currentCandidate)) {
            results.push({
              index: target.index,
              candidateRef: target.candidateRef,
              candidateName: currentCandidate.name,
              candidateId: currentCandidate.candidateId,
              success: false,
              error: `候选人引用 ${target.candidateRef} 已过期，请重新获取推荐列表`,
            });
            continue;
          }
        }

        const result = await nativePage.clickRecommendGreet(target.index, {
          preClickDelayMs: SAY_HELLO_CLICK_PRE_DELAY_MS,
          pressDurationMs: SAY_HELLO_CLICK_PRESS_MS,
          settleMs: SAY_HELLO_CLICK_SETTLE_MS,
          ...(session !== undefined ? { motionObserver: session } : {}),
        });

        results.push({
          index: target.index,
          candidateRef: target.candidateRef,
          candidateName: result.name,
          candidateId: result.candidateId,
          success: result.clicked,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
        recordZhipinCandidateContactedEvent(result, ctx.logger);
      }

      const summary = {
        total: results.length,
        succeeded: results.filter((result) => result.success).length,
        failed: results.filter((result) => !result.success).length,
      };
      if (summary.failed === 0) {
        await session.succeed(`已完成 ${summary.succeeded}/${summary.total} 位候选人`);
      } else {
        await session.fail(`已完成 ${summary.succeeded}/${summary.total} 位候选人`);
      }

      return { success: summary.failed === 0, results, summary };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await session?.fail(error);
      const results = candidateTargets.map((target) => ({
        index: target.index,
        candidateRef: target.candidateRef,
        candidateName: "",
        candidateId: "",
        success: false,
        error,
      }));
      return {
        success: false,
        results,
        summary: { total: results.length, succeeded: 0, failed: results.length },
      };
    } finally {
      nativePage?.close();
    }
  },
});

function hasStableCandidateIdentity(target: ZhipinCandidateRefTarget): boolean {
  return target.candidateId.length > 0 || (target.name !== undefined && target.name.length > 0);
}
