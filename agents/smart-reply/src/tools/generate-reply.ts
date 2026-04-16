import { defineTool } from "@roll-agent/sdk";
import { generateSignedReply } from "../services/reply-authority-client.ts";
import {
  GenerateReplyToolInputSchema,
  GenerateSignedReplyResponseSchema,
} from "../types/reply-authority.ts";

export const generateReply = defineTool({
  name: "generate_reply",
  description:
    "根据候选人消息生成智能招聘回复，并向 Reply Authority Service 请求签名信封；调用方必须显式提供 target 以绑定 tenantId/conversationId/candidateId。",
  input: GenerateReplyToolInputSchema,
  output: GenerateSignedReplyResponseSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Processing message: ${input.candidateMessage.slice(0, 50)}...`);
    const result = await generateSignedReply(input);
    ctx.logger.info(
      `Signed reply generated. Stage: ${result.stage}, Confidence: ${result.confidence}`,
    );
    return result;
  },
});
