import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { BrowserActionApprovalSchema } from "@roll-agent/browser";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import { sendReply } from "../pages/yupao/chat.ts";
import {
  assertBrowserActionAllowed,
  createBrowserActionPolicyOptions,
  toStructuredBrowserActionError,
} from "../browser-security.ts";

const SendReplyInputSchema = z.object({
  conversationId: z.string().describe("对话 ID"),
  message: z.string().describe("要发送的回复消息"),
  browserActionApproval: BrowserActionApprovalSchema.optional().describe(
    "当 actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
  ),
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
    const runtime = getRuntime();
    const guard = assertBrowserActionAllowed(ctx, runtime, {
      action: "yupao_send_reply",
      target: conversationId,
      ...(input.browserActionApproval !== undefined
        ? { approval: input.browserActionApproval }
        : {}),
    });

    const page = await ctxManager.getPage("yupao");

    let result: Awaited<ReturnType<typeof sendReply>>;
    try {
      result = await sendReply(
        page,
        conversationId,
        message,
        createBrowserActionPolicyOptions(ctx, runtime, {
          approval: input.browserActionApproval,
          approvedByConfirmation: guard.approvedByConfirmation,
        }),
      );
    } catch (error) {
      const structuredError = toStructuredBrowserActionError(error);
      if (structuredError !== undefined) {
        throw structuredError;
      }
      throw error;
    }

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
