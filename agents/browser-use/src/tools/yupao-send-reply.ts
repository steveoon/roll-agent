import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { sendReply } from "../pages/yupao/chat.ts";

const SendReplyInputSchema = z.object({
  conversationId: z.string().describe("对话 ID"),
  message: z.string().describe("要发送的回复消息"),
});

const SendReplyOutputSchema = z.object({
  success: z.boolean(),
  conversationId: z.string(),
  sentMessage: z.string(),
  error: z.string().optional(),
});

export const yupaoSendReply = defineTool({
  name: "yupao_send_reply",
  description: "向鱼泡指定对话发送回复消息",
  input: SendReplyInputSchema,
  output: SendReplyOutputSchema,
  execute: async (input, ctx) => {
    const { conversationId, message } = input;
    ctx.logger.info(`Sending reply to yupao conversation ${conversationId}`);

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("yupao");

    const result = await sendReply(page, conversationId, message);

    if (result.success) {
      ctx.logger.info("Reply sent successfully");
    } else {
      ctx.logger.error(`Failed to send reply: ${result.error}`);
    }

    return {
      success: result.success,
      conversationId,
      sentMessage: message,
      error: result.error,
    };
  },
});
