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
import {
  buildZhipinCandidateRef,
  ZHIPIN_CANDIDATE_REF_PATTERN,
  isZhipinCandidateTargetCurrent,
  resolveZhipinCandidateIndex,
  resolveZhipinCandidateRefTarget,
  type ZhipinCandidateRefTarget,
} from "../pages/zhipin/semantic-refs.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  candidateRef: z.string().optional(),
  candidateName: z.string(),
  candidateId: z.string(),
  error: z.string().optional(),
});

const InputSchema = z
  .object({
    index: z.number().int().min(0).optional().describe("候选人在列表中的 0-based 索引"),
    candidateRef: z
      .string()
      .regex(ZHIPIN_CANDIDATE_REF_PATTERN, "candidateRef 应类似 @c1")
      .optional()
      .describe("候选人语义引用，如 @c1；来自 zhipin_get_candidate_list 输出"),
  })
  .refine(
    (input) => input.index !== undefined || input.candidateRef !== undefined,
    "必须提供 index 或 candidateRef",
  );

export const zhipinOpenResume = defineTool({
  name: "zhipin_open_resume",
  description: "在推荐列表页点击候选人卡片打开简历详情弹窗",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const candidateTarget = resolveOpenResumeCandidateTarget(input);
    const index = candidateTarget.index;
    const candidateRef = candidateTarget.candidateRef;
    ctx.logger.info(`Opening resume for candidate ${candidateRef} at index ${index}`);

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    const target = getRecommendTarget(page);

    const listReady = await waitForRecommendList(target);
    if (!listReady) {
      return {
        success: false,
        candidateRef,
        candidateName: "",
        candidateId: "",
        error: "推荐列表未加载",
      };
    }

    const clickResult = await inspectRecommendCard(target, index);

    if (!clickResult.found) {
      return {
        success: false,
        candidateRef,
        candidateName: "",
        candidateId: "",
        error: clickResult.error ?? `候选人引用 ${candidateRef} 超出范围`,
      };
    }

    if (
      hasStableCandidateIdentity(candidateTarget) &&
      !isZhipinCandidateTargetCurrent(candidateTarget, clickResult)
    ) {
      return {
        success: false,
        candidateRef,
        candidateName: clickResult.name,
        candidateId: clickResult.candidateId,
        error: `候选人引用 ${candidateRef} 已过期，请重新获取推荐列表`,
      };
    }

    const card = target.locator(clickResult.cardSelector).nth(index);
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
    return {
      success: true,
      candidateRef,
      candidateName: clickResult.name,
      candidateId: clickResult.candidateId,
    };
  },
});

function resolveOpenResumeCandidateTarget(
  input: z.infer<typeof InputSchema>,
): ZhipinCandidateRefTarget {
  if (input.candidateRef !== undefined) {
    return resolveZhipinCandidateRefTarget(input.candidateRef);
  }

  const index = resolveZhipinCandidateIndex(input);
  return {
    index,
    candidateRef: buildZhipinCandidateRef(index),
    candidateId: "",
  };
}

function hasStableCandidateIdentity(target: ZhipinCandidateRefTarget): boolean {
  return target.candidateId.length > 0 || (target.name !== undefined && target.name.length > 0);
}
