import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  humanDelay,
  shouldAddRandomBehavior,
  performRandomScroll,
} from "../pages/zhipin/anti-detection.ts";
import {
  getRecommendTarget,
  inspectRecommendCard,
  waitForRecommendList,
} from "../pages/zhipin/recommend-list.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

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

type RecommendTarget = ReturnType<typeof getRecommendTarget>;
type VisualActivitySessionLike = Pick<
  VisualActivitySession,
  "begin" | "highlightSelector" | "highlightLocator" | "succeed" | "fail" | "retarget"
>;
type ZhipinSayHelloDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly getRecommendTarget: typeof getRecommendTarget;
  readonly waitForRecommendList: typeof waitForRecommendList;
  readonly inspectRecommendCard: typeof inspectRecommendCard;
  readonly moveVisualCursorToLocator: typeof moveVisualCursorToLocator;
  readonly showVisualClickOnLocator: typeof showVisualClickOnLocator;
  readonly humanDelay: typeof humanDelay;
  readonly shouldAddRandomBehavior: typeof shouldAddRandomBehavior;
  readonly performRandomScroll: typeof performRandomScroll;
  readonly createVisualActivitySession: (target: RecommendTarget) => VisualActivitySessionLike;
};

let zhipinSayHelloDepsOverride: Partial<ZhipinSayHelloDeps> | undefined;

function getZhipinSayHelloDeps(): ZhipinSayHelloDeps {
  return {
    getContextManager,
    getRecommendTarget,
    waitForRecommendList,
    inspectRecommendCard,
    moveVisualCursorToLocator,
    showVisualClickOnLocator,
    humanDelay,
    shouldAddRandomBehavior,
    performRandomScroll,
    createVisualActivitySession: (target) => new VisualActivitySession(target),
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
  input: z.object({ indices: z.array(z.number()).describe("要打招呼的候选人索引列表") }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Saying hello to ${input.indices.length} candidates`);

    const deps = getZhipinSayHelloDeps();
    const ctxManager = deps.getContextManager();
    const page = await ctxManager.getPage("zhipin");
    let target = deps.getRecommendTarget(page);
    const session = deps.createVisualActivitySession(target);
    const beginLabel = "正在打开推荐列表";
    const batchLabel = input.indices.length > 1 ? "正在批量打招呼" : "正在打招呼";

    await session.begin(beginLabel);
    const listReady = await deps.waitForRecommendList(target);
    target = deps.getRecommendTarget(page);
    await session.retarget(target);
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

    await session.begin(batchLabel);
    await session.highlightSelector(".candidate-card-wrap, [data-geek], .geek-item", {
      label: batchLabel,
      padding: 8,
    });

    const results: Array<{
      index: number;
      candidateName: string;
      candidateId: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const idx of input.indices) {
      try {
        const r = await deps.inspectRecommendCard(target, idx);

        if (!r.found) {
          results.push({
            index: idx,
            candidateName: "",
            candidateId: "",
            success: false,
            ...(r.error !== undefined ? { error: r.error } : {}),
          });
        } else if (!r.hasGreetButton) {
          results.push({
            index: idx,
            candidateName: r.name,
            candidateId: r.candidateId,
            success: false,
            error: "未找到打招呼按钮",
          });
        } else {
          const card = target.locator(r.cardSelector).nth(idx);
          const greetButton = card.locator("button.btn.btn-greet").first();

          await session.highlightLocator(card, {
            label: `正在定位第 ${idx + 1} 位候选人`,
            padding: 10,
          });
          await greetButton.scrollIntoViewIfNeeded();
          await deps.moveVisualCursorToLocator(page, greetButton, {
            durationMs: 90,
            settleMs: 20,
            target,
          });
          await greetButton.hover();
          await deps.showVisualClickOnLocator(page, greetButton, {
            pulseDurationMs: 160,
            target,
          });
          await greetButton.click();

          results.push({
            index: idx,
            candidateName: r.name,
            candidateId: r.candidateId,
            success: true,
          });
        }

        await deps.humanDelay(page);
        if (deps.shouldAddRandomBehavior(0.3)) {
          await deps.performRandomScroll(page);
        }
      } catch (err) {
        results.push({
          index: idx,
          candidateName: "",
          candidateId: "",
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
    if (summary.failed === 0) {
      await session.succeed(`已完成 ${summary.succeeded}/${summary.total} 位候选人`);
    } else {
      await session.fail(`已完成 ${summary.succeeded}/${summary.total} 位候选人`);
    }
    ctx.logger.info(`Say hello: ${summary.succeeded}/${summary.total} succeeded`);
    return { success: summary.failed === 0, results, summary };
  },
});
