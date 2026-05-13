import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { consumePreparedReply } from "../reply-authority/prepared-reply-store.ts";
import { sendSignedZhipinReply } from "./zhipin-send-reply.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  sentMessage: z.string(),
  error: z.string().optional(),
});

function formatPreparedReplyError(reason: "not_found" | "expired" | "consumed"): string {
  if (reason === "expired") {
    return "preparedReplyId 已过期，请重新生成回复";
  }
  if (reason === "consumed") {
    return "preparedReplyId 已消费，禁止重复发送";
  }
  return "preparedReplyId 不存在，请重新生成回复";
}

export const zhipinSendPreparedReply = defineTool({
  name: "zhipin_send_prepared_reply",
  description:
    "发送由 zhipin_generate_reply_preview 生成的预备回复；只接收 preparedReplyId，不接收 signedEnvelope。",
  input: z.object({
    preparedReplyId: z
      .string()
      .min(1)
      .describe("预备回复 ID，由 zhipin_generate_reply_preview 返回"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const consumed = consumePreparedReply(input.preparedReplyId);
    if (!consumed.ok) {
      return {
        success: false,
        sentMessage: "",
        error: formatPreparedReplyError(consumed.reason),
      };
    }

    return await sendSignedZhipinReply(
      {
        signedEnvelope: consumed.record.signedEnvelope,
      },
      ctx,
    );
  },
});
