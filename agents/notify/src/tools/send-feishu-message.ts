import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { FEISHU_WEBHOOK_ERROR_TYPES, sendFeishuWebhook } from "../services/feishu.ts";

const InputSchema = z
  .object({
    text: z.string().trim().min(1).describe("调用方已组织好的飞书文本消息内容"),
  })
  .strict();

const providerSchema = z.literal("feishu");
const errorTypeSchema = z.enum(["config", "internal", ...FEISHU_WEBHOOK_ERROR_TYPES]);

const OutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    provider: providerSchema,
    responseCode: z.number(),
    responseMessage: z.string(),
  }),
  z.object({
    success: z.literal(false),
    provider: providerSchema,
    errorType: errorTypeSchema,
    error: z.string(),
    responseCode: z.number().optional(),
    responseMessage: z.string().optional(),
  }),
]);

type SendFeishuMessageOutput = z.infer<typeof OutputSchema>;

export const sendFeishuMessage = defineTool({
  name: "send_feishu_message",
  description: "向飞书自定义机器人发送纯文本消息。消息内容由调用方组织，本工具只负责发送。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const webhookUrl = resolveWebhookUrl(process.env["FEISHU_BOT_WEBHOOK"]);
    if (!webhookUrl.ok) {
      ctx.logger.warn(`Feishu message skipped: ${webhookUrl.error}`);
      return createFailure("config", webhookUrl.error);
    }

    ctx.logger.info(`Sending feishu message (${input.text.length} chars)`);

    try {
      const result = await sendFeishuWebhook(webhookUrl.value, input.text);

      if (result.success) {
        ctx.logger.info("Feishu message sent successfully");
        return {
          success: true,
          provider: "feishu",
          responseCode: result.responseCode,
          responseMessage: result.responseMessage,
        };
      }

      ctx.logger.warn(`Feishu message failed [${result.errorType}]: ${result.error}`);
      return {
        success: false,
        provider: "feishu",
        errorType: result.errorType,
        error: result.error,
        ...(result.responseCode !== undefined ? { responseCode: result.responseCode } : {}),
        ...(result.responseMessage ? { responseMessage: result.responseMessage } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(`Unexpected Feishu send failure: ${message}`);
      return createFailure("internal", `Unexpected Feishu send failure: ${message}`);
    }
  },
});

function createFailure(
  errorType: Extract<SendFeishuMessageOutput, { success: false }>["errorType"],
  error: string,
): SendFeishuMessageOutput {
  return {
    success: false,
    provider: "feishu",
    errorType,
    error,
  };
}

function resolveWebhookUrl(
  rawWebhookUrl: string | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!rawWebhookUrl || rawWebhookUrl.trim().length === 0) {
    return {
      ok: false,
      error:
        "环境变量 FEISHU_BOT_WEBHOOK 未配置，请在 roll.config.yaml 的 agents.env.notify-agent 或系统环境变量中设置。",
    };
  }

  try {
    const parsed = new URL(rawWebhookUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        ok: false,
        error: "环境变量 FEISHU_BOT_WEBHOOK 必须是 http 或 https URL。",
      };
    }

    return { ok: true, value: parsed.toString() };
  } catch {
    return {
      ok: false,
      error: "环境变量 FEISHU_BOT_WEBHOOK 不是合法 URL。",
    };
  }
}
