import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { randomDelay } from "../pages/zhipin/anti-detection.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  candidateName: z.string(),
  candidateId: z.string(),
  error: z.string().optional(),
});

export const zhipinOpenResume = defineTool({
  name: "zhipin_open_resume",
  description: "在推荐列表页点击候选人卡片打开简历详情弹窗",
  input: z.object({ index: z.number().describe("候选人在列表中的索引") }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Opening resume for candidate at index ${input.index}`);

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    const frame =
      page.frame("recommendFrame") ?? page.frames().find((f) => f.url().includes("recommend"));
    const target = frame ?? page;

    try {
      await target.waitForSelector("[data-geek], .geek-item", { timeout: 10_000 });
    } catch {
      return { success: false, candidateName: "", candidateId: "", error: "推荐列表未加载" };
    }

    const clickResult = await target.evaluate((idx: number) => {
      const items = document.querySelectorAll("[data-geek], .geek-item");
      const item = items[idx] as HTMLElement | undefined;
      if (!item) return { found: false as const };
      const candidateId = item.getAttribute("data-geek") ?? "";
      const name = item.querySelector(".name")?.textContent?.trim() ?? "";
      item.click();
      return { found: true as const, candidateId, name };
    }, input.index);

    if (!clickResult.found) {
      return {
        success: false,
        candidateName: "",
        candidateId: "",
        error: `索引 ${input.index} 超出范围`,
      };
    }

    await randomDelay(page, 1000, 2000);
    ctx.logger.info(`Opened resume for ${clickResult.name}`);
    return { success: true, candidateName: clickResult.name, candidateId: clickResult.candidateId };
  },
});
