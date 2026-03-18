import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { goToConversation } from "../pages/zhipin/navigation.ts";
import { parseCandidateProfile } from "../pages/zhipin/candidate-profile.ts";

const GetCandidateInfoInputSchema = z.object({
  conversationId: z.string().describe("对话 ID，用于导航到候选人资料"),
});

/** 兼容 smart-reply CandidateInfoSchema 的子集 */
const CandidateInfoOutputSchema = z.object({
  name: z.string().optional(),
  age: z.string().optional(),
  gender: z.string().optional(),
  experience: z.string().optional(),
  education: z.string().optional(),
  expectedSalary: z.string().optional(),
  expectedPosition: z.string().optional(),
  activeTime: z.string().optional(),
  fullText: z.string().optional(),
});

export const zhipinGetCandidateInfo = defineTool({
  name: "zhipin_get_candidate_info",
  description: "从 BOSS直聘对话页提取候选人资料信息",
  input: GetCandidateInfoInputSchema,
  output: CandidateInfoOutputSchema,
  execute: async (input, ctx) => {
    const { conversationId } = input;
    ctx.logger.info(`Getting candidate info for conversation ${conversationId}`);

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    await goToConversation(page, conversationId);
    const profile = await parseCandidateProfile(page);

    ctx.logger.info(`Candidate info extracted: ${profile.name ?? "unknown"}`);
    return { ...profile };
  },
});
