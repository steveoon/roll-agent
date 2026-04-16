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

export const zhipinSayHello = defineTool({
  name: "zhipin_say_hello",
  description: "在推荐列表页对候选人点击「打招呼」按钮（支持批量）",
  input: z.object({ indices: z.array(z.number()).describe("要打招呼的候选人索引列表") }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Saying hello to ${input.indices.length} candidates`);

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    const target = getRecommendTarget(page);
    const listReady = await waitForRecommendList(target);
    if (!listReady) {
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

    const results: Array<{
      index: number;
      candidateName: string;
      candidateId: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const idx of input.indices) {
      try {
        const r = await inspectRecommendCard(target, idx);

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

          await greetButton.scrollIntoViewIfNeeded();
          await greetButton.hover();
          await humanDelay(page);
          await greetButton.click();

          results.push({
            index: idx,
            candidateName: r.name,
            candidateId: r.candidateId,
            success: true,
          });
        }

        await humanDelay(page);
        if (shouldAddRandomBehavior(0.3)) {
          await performRandomScroll(page);
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
    ctx.logger.info(`Say hello: ${summary.succeeded}/${summary.total} succeeded`);
    return { success: summary.failed === 0, results, summary };
  },
});
