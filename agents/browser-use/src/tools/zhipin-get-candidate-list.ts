import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";

const CandidateCardSchema = z.object({
  index: z.number(),
  candidateId: z.string(),
  name: z.string(),
  age: z.string(),
  experience: z.string(),
  education: z.string(),
  workStatus: z.string(),
  company: z.string(),
  currentPosition: z.string(),
  expectedLocation: z.string(),
  expectedPosition: z.string(),
  expectedSalary: z.string(),
  tags: z.array(z.string()),
  buttonText: z.string(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  candidates: z.array(CandidateCardSchema),
  total: z.number(),
  error: z.string().optional(),
});

export const zhipinGetCandidateList = defineTool({
  name: "zhipin_get_candidate_list",
  description: "获取推荐列表页的候选人卡片信息",
  input: z.object({ maxResults: z.number().optional().describe("最多返回条数") }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info("Getting candidate list from recommend page");

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    const frame =
      page.frame("recommendFrame") ?? page.frames().find((f) => f.url().includes("recommend"));
    const target = frame ?? page;

    try {
      await target.waitForSelector("[data-geek], .geek-item", { timeout: 10_000 });
    } catch {
      return { success: false, candidates: [], total: 0, error: "推荐列表未加载" };
    }

    const candidates = await target.evaluate((maxRes: number | undefined) => {
      // 优先用 .candidate-card-wrap（按钮在这一层），fallback 到 [data-geek]
      let items = Array.from(document.querySelectorAll(".candidate-card-wrap"));
      if (items.length === 0) {
        // fallback: 直接用 card-inner[data-geek]
        items = Array.from(document.querySelectorAll("[data-geek], .geek-item"));
      }
      const limit = maxRes ?? items.length;
      const result: Array<{
        index: number;
        candidateId: string;
        name: string;
        age: string;
        experience: string;
        education: string;
        workStatus: string;
        company: string;
        currentPosition: string;
        expectedLocation: string;
        expectedPosition: string;
        expectedSalary: string;
        tags: string[];
        buttonText: string;
      }> = [];

      items.forEach((item, idx) => {
        if (idx >= limit) return;

        // candidateId 可能在自身或子元素 .card-inner 上
        const candidateId =
          item.getAttribute("data-geek") ??
          item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
          "";
        const name = item.querySelector(".name")?.textContent?.trim() ?? "";

        // base-info 解析 — join-text-wrap 的分隔符由 CSS 伪元素渲染
        // 实际 DOM: <div class="base-info join-text-wrap"><span>47岁</span><span>10年以上</span>...</div>
        let age = "";
        let experience = "";
        let education = "";
        let workStatus = "";
        const baseInfoEl = item.querySelector(".base-info.join-text-wrap, .base-info");
        if (baseInfoEl) {
          const textParts: string[] = [];

          // 策略 1: 遍历子元素（span 等），每个子元素是一个独立字段
          const children = baseInfoEl.querySelectorAll(":scope > *");
          children.forEach((child) => {
            const t = child.textContent?.trim();
            if (t) textParts.push(t);
          });

          // 策略 2: 子元素为空时，尝试文本节点
          if (textParts.length <= 1) {
            textParts.length = 0;
            baseInfoEl.childNodes.forEach((node) => {
              if (node.nodeType === Node.TEXT_NODE) {
                const t = node.textContent?.trim();
                if (t) textParts.push(t);
              }
            });
          }

          // 策略 3: 仍为空时，整体 textContent 按分隔符切割
          if (textParts.length <= 1) {
            const fullText = baseInfoEl.textContent?.trim() ?? "";
            textParts.length = 0;
            fullText.split(/[丨·|]/).forEach((s) => {
              const t = s.trim();
              if (t) textParts.push(t);
            });
          }

          for (const p of textParts) {
            if (!age && p.includes("岁")) {
              age = p;
            } else if (
              !experience &&
              (p.includes("年") || p.includes("应届") || p.includes("在校"))
            ) {
              experience = p;
            } else if (!education && /(初中|高中|中专|中技|大专|本科|硕士|博士)/.test(p)) {
              education = p;
            } else if (!workStatus && /(在职|离职|在校)/.test(p)) {
              workStatus = p;
            }
          }
        }

        // 工作经历
        const workExpEl =
          item.querySelector(".timeline-wrap.work-exps .content.join-text-wrap") ??
          item.querySelector(".timeline-wrap.work-exps .content");
        const workText = workExpEl?.textContent?.trim() ?? "";
        const workParts = workText.split("·").map((s) => s.trim());
        const company = workParts[0] ?? "";
        const currentPosition = workParts[1] ?? "";

        // 期望信息 — 兼容新版 .row-flex 和旧版 .timeline-wrap.expect
        let expectedLocation = "";
        let expectedPosition = "";
        const expectRow = item.querySelector(".row-flex:not(.geek-desc)");
        if (expectRow) {
          const labelEl = expectRow.querySelector(".label");
          const contentEl = expectRow.querySelector(".content");
          const labelText = labelEl?.textContent ?? "";
          if ((labelText.includes("期望") || labelText.includes("最近关注")) && contentEl) {
            const parts = (contentEl.textContent?.trim() ?? "").split("·").map((s) => s.trim());
            expectedLocation = parts[0] ?? "";
            expectedPosition = parts[1] ?? "";
          }
        }
        if (!expectedLocation) {
          const expectEl =
            item.querySelector(".timeline-wrap.expect .content.join-text-wrap") ??
            item.querySelector(".timeline-wrap.expect .content");
          if (expectEl) {
            const parts = (expectEl.textContent?.trim() ?? "").split("·").map((s) => s.trim());
            expectedLocation = parts[0] ?? "";
            expectedPosition = parts[1] ?? "";
          }
        }

        const expectedSalary = item.querySelector(".salary-wrap")?.textContent?.trim() ?? "";

        const tags: string[] = [];
        item.querySelectorAll(".tags-wrap .tag-item, .tags-wrap .tag, .tags-wrap span").forEach(
          (t) => {
            const text = t.textContent?.trim();
            if (text) tags.push(text);
          },
        );

        // 按钮在 .candidate-card-wrap 层
        const buttonText =
          item.querySelector("button.btn.btn-greet")?.textContent?.trim() ?? "";

        result.push({
          index: idx,
          candidateId,
          name,
          age,
          experience,
          education,
          workStatus,
          company,
          currentPosition,
          expectedLocation,
          expectedPosition,
          expectedSalary,
          tags,
          buttonText,
        });
      });
      return result;
    }, input.maxResults);

    ctx.logger.info(`Found ${candidates.length} candidates in recommend list`);
    return { success: true, candidates, total: candidates.length };
  },
});
