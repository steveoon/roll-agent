import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { recordZhipinCandidateContactedEvent } from "../recruitment-events/zhipin-events.ts";

const ResultItemSchema = z.object({
  index: z.number(),
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

const SAY_HELLO_BATCH_INTERVAL_MS = [2_400, 3_100, 3_800] as const;
const SAY_HELLO_CLICK_PRE_DELAY_MS = 650;
const SAY_HELLO_CLICK_PRESS_MS = 140;
const SAY_HELLO_CLICK_SETTLE_MS = 1_200;

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
  input: z.object({
    indices: z.array(z.number()).min(1).describe("要打招呼的候选人索引列表"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Saying hello to ${input.indices.length} candidates through native CDP`);

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
        const results = input.indices.map((index) => ({
          index,
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

      const batchLabel = input.indices.length > 1 ? "正在批量打招呼" : "正在打招呼";
      await session.begin(batchLabel);
      await session.highlightSelector(".candidate-card-wrap, [data-geek], .geek-item", {
        label: batchLabel,
        padding: 8,
      });

      const results: Array<z.infer<typeof ResultItemSchema>> = [];
      for (const [position, idx] of input.indices.entries()) {
        if (position > 0) {
          const interval =
            SAY_HELLO_BATCH_INTERVAL_MS[(position - 1) % SAY_HELLO_BATCH_INTERVAL_MS.length] ??
            SAY_HELLO_BATCH_INTERVAL_MS[0];
          await deps.sleep(interval);
        }

        const result = await nativePage.clickRecommendGreet(idx, {
          preClickDelayMs: SAY_HELLO_CLICK_PRE_DELAY_MS,
          pressDurationMs: SAY_HELLO_CLICK_PRESS_MS,
          settleMs: SAY_HELLO_CLICK_SETTLE_MS,
          ...(session !== undefined ? { motionObserver: session } : {}),
        });

        results.push({
          index: idx,
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
      const results = input.indices.map((index) => ({
        index,
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
