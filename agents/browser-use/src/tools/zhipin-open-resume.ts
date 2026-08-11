import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  buildZhipinCandidateRef,
  ZHIPIN_CANDIDATE_REF_PATTERN,
  isZhipinCandidateTargetCurrent,
  resolveZhipinCandidateIndex,
  resolveZhipinCandidateRefTarget,
  type ZhipinCandidateRefTarget,
} from "../pages/zhipin/semantic-refs.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  candidateRef: z.string().optional(),
  candidateName: z.string(),
  candidateId: z.string(),
  resumeReady: z.boolean().optional(),
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

type ZhipinOpenResumeDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
};

let zhipinOpenResumeDepsOverride: Partial<ZhipinOpenResumeDeps> | undefined;

function getZhipinOpenResumeDeps(): ZhipinOpenResumeDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    ...zhipinOpenResumeDepsOverride,
  };
}

export function setZhipinOpenResumeDepsForTests(
  override: Partial<ZhipinOpenResumeDeps> | undefined,
): void {
  zhipinOpenResumeDepsOverride = override;
}

export const zhipinOpenResume = defineTool({
  name: "zhipin_open_resume",
  description: "在推荐列表页点击候选人卡片打开简历详情弹窗",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const candidateTarget = resolveOpenResumeCandidateTarget(input);
    const index = candidateTarget.index;
    const candidateRef = candidateTarget.candidateRef;
    ctx.logger.info(
      `Opening resume for candidate ${candidateRef} at index ${String(index)} through native backend`,
    );

    const deps = getZhipinOpenResumeDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySession | undefined;

    try {
      nativePage = await deps.openNativePagePort();
      session = new NativeVisualActivitySession(nativePage);
      await session.begin("正在打开简历详情");

      const listReady = await nativePage.waitForRecommendList();
      if (!listReady) {
        await session.fail("推荐列表未加载");
        return failure(candidateRef, "推荐列表未加载");
      }

      const inspection = await nativePage.inspectRecommendCard(index);
      if (!inspection.found) {
        const error = inspection.error ?? `候选人引用 ${candidateRef} 超出范围`;
        await session.fail(error);
        return failure(candidateRef, error);
      }

      if (
        hasStableCandidateIdentity(candidateTarget) &&
        !isZhipinCandidateTargetCurrent(candidateTarget, inspection)
      ) {
        const error = `候选人引用 ${candidateRef} 已过期，请重新获取推荐列表`;
        await session.fail(error);
        return {
          success: false,
          candidateRef,
          candidateName: inspection.name,
          candidateId: inspection.candidateId,
          error,
        };
      }

      const clicked = await nativePage.clickRecommendCardSurface(index);
      if (!clicked) {
        await session.fail("未能点击候选人卡片");
        return {
          success: false,
          candidateRef,
          candidateName: inspection.name,
          candidateId: inspection.candidateId,
          error: "未能点击候选人卡片",
        };
      }

      const dialogState = await nativePage.waitForResumeDialog(12_000);
      const resumeReady = dialogState.canvasReady;
      if (!dialogState.iframeFound) {
        await session.fail("简历弹窗未出现");
        return {
          success: false,
          candidateRef,
          candidateName: inspection.name,
          candidateId: inspection.candidateId,
          resumeReady: false,
          error: "点击后简历弹窗未出现",
        };
      }

      await session.succeed(`已打开 ${inspection.name} 的简历`);
      ctx.logger.info(`Opened resume for ${inspection.name}`);
      return {
        success: true,
        candidateRef,
        candidateName: inspection.name,
        candidateId: inspection.candidateId,
        resumeReady,
        ...(resumeReady ? {} : { error: "简历弹窗已出现，但 canvas 尚未就绪" }),
      };
    } finally {
      nativePage?.close();
    }
  },
});

function failure(candidateRef: string | undefined, error: string) {
  return {
    success: false,
    ...(candidateRef !== undefined ? { candidateRef } : {}),
    candidateName: "",
    candidateId: "",
    error,
  };
}

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
