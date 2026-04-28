import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { randomDelay } from "../pages/zhipin/anti-detection.ts";
import {
  getRecommendTarget,
  inspectRecommendCard,
  waitForRecommendList,
} from "../pages/zhipin/recommend-list.ts";
import { ZHIPIN_RESUME_CARD_CLICK_SURFACE_SELECTOR } from "../pages/zhipin/resume-dom-contract.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

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
    const target = getRecommendTarget(page);

    const listReady = await waitForRecommendList(target);
    if (!listReady) {
      return { success: false, candidateName: "", candidateId: "", error: "推荐列表未加载" };
    }

    const clickResult = await inspectRecommendCard(target, input.index);

    if (!clickResult.found) {
      return {
        success: false,
        candidateName: "",
        candidateId: "",
        error: clickResult.error ?? `索引 ${input.index} 超出范围`,
      };
    }

    const card = target.locator(clickResult.cardSelector).nth(input.index);
    const clickSurface =
      (await card.locator(ZHIPIN_RESUME_CARD_CLICK_SURFACE_SELECTOR).count()) > 0
        ? card.locator(ZHIPIN_RESUME_CARD_CLICK_SURFACE_SELECTOR).first()
        : card;

    await clickSurface.scrollIntoViewIfNeeded();
    await moveVisualCursorToLocator(page, clickSurface, { target });
    await clickSurface.hover();
    await randomDelay(page, 200, 400);
    await showVisualClickOnLocator(page, clickSurface, { target });
    await clickSurface.click();

    await randomDelay(page, 1000, 2000);
    ctx.logger.info(`Opened resume for ${clickResult.name}`);
    return { success: true, candidateName: clickResult.name, candidateId: clickResult.candidateId };
  },
});
