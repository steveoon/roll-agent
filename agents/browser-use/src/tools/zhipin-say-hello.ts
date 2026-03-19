import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  humanDelay,
  shouldAddRandomBehavior,
  performRandomScroll,
} from "../pages/zhipin/anti-detection.ts";

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
    const frame =
      page.frame("recommendFrame") ?? page.frames().find((f) => f.url().includes("recommend"));
    const target = frame ?? page;

    const results: Array<{
      index: number;
      candidateName: string;
      candidateId: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const idx of input.indices) {
      try {
        const r = await target.evaluate((targetIdx: number) => {
          // 优先用 .candidate-card-wrap 定位（按钮在这一层），fallback 到 [data-geek]
          let items = Array.from(document.querySelectorAll(".candidate-card-wrap"));
          if (items.length === 0) {
            items = Array.from(document.querySelectorAll("[data-geek], .geek-item"));
          }
          const item = items[targetIdx];
          if (!item) return { found: false as const, error: "索引超出范围" };

          // candidateId 可能在自身或子元素 .card-inner 上
          const candidateId =
            item.getAttribute("data-geek") ??
            item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
            "";
          const name = item.querySelector(".name")?.textContent?.trim() ?? "";

          // 按钮在 .candidate-card-wrap 层，不在 .card-inner 内
          const btn = item.querySelector("button.btn.btn-greet") as HTMLElement | null;
          if (!btn || btn.offsetWidth === 0) {
            return {
              found: true as const,
              candidateId,
              name,
              clicked: false,
              error: "未找到打招呼按钮",
            };
          }

          // 模拟完整点击事件序列
          btn.scrollIntoView({ behavior: "instant", block: "center" });
          const rect = btn.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const evtOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
          btn.dispatchEvent(new MouseEvent("mousedown", evtOpts));
          btn.dispatchEvent(new MouseEvent("mouseup", evtOpts));
          btn.dispatchEvent(new MouseEvent("click", evtOpts));
          btn.click();

          return { found: true as const, candidateId, name, clicked: true };
        }, idx);

        if (!r.found) {
          results.push({
            index: idx,
            candidateName: "",
            candidateId: "",
            success: false,
            ...(r.error !== undefined ? { error: r.error } : {}),
          });
        } else if (!r.clicked) {
          results.push({
            index: idx,
            candidateName: r.name,
            candidateId: r.candidateId,
            success: false,
            ...(r.error !== undefined ? { error: r.error } : {}),
          });
        } else {
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
