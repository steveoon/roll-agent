import { defineTool } from "@roll-agent/sdk";
import { generateSignedReply } from "../services/reply-authority-client.ts";
import {
  GenerateReplyToolInputSchema,
  GenerateSignedReplyResponseSchema,
} from "../types/reply-authority.ts";

export const generateReply = defineTool({
  name: "generate_reply",
  description:
    "根据候选人消息生成智能招聘回复，并向 Reply Authority Service 请求签名信封；调用方必须提供 target 以绑定会话和招聘者身份，可直接传 tenantId+recruiterBinding，或只传 recruiterUsername 交给 smart-reply 代理解析。",
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
