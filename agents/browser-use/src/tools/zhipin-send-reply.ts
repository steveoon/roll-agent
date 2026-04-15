import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { randomDelay } from "../pages/zhipin/anti-detection.ts";
import { ensureChatOpen } from "../pages/zhipin/chat-navigation.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  sentMessage: z.string(),
  error: z.string().optional(),
});

export const zhipinSendReply = defineTool({
  name: "zhipin_send_reply",
  description:
    "发送消息。可指定 candidateName 自动打开对应聊天后发送，或不传则发送到当前窗口；例如“回复鲁倩：你好”应提取 candidateName=鲁倩。",
  input: z.object({
    message: z.string().describe("要发送的消息内容"),
    candidateName: z
      .string()
      .optional()
      .describe("候选人姓名。若用户说“回复鲁倩”，这里应提取为“鲁倩”"),
    index: z.number().optional().describe("候选人在列表中的索引（可选）"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const { message } = input;

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    // 如果指定了候选人，先导航到对应聊天
    const nav = await ensureChatOpen(ctxManager, page, {
      candidateName: input.candidateName,
      index: input.index,
    });
    if (nav && !nav.found) {
      return { success: false, sentMessage: message, error: nav.error };
    }

    ctx.logger.info(`Sending message (${message.length} chars)${nav ? ` to ${nav.name}` : ""}`);
    const activePage = await ctxManager.getPage("zhipin");

    try {
      const inputSelector = "#boss-chat-editor-input, textarea.chat-input, .chat-input";
      await activePage.waitForSelector(inputSelector, { timeout: 5_000 });

      const isContentEditable = await activePage.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return el?.getAttribute("contenteditable") === "true";
      }, inputSelector);

      if (isContentEditable) {
        await activePage.evaluate(
          (args: { sel: string; msg: string }) => {
            const el = document.querySelector(args.sel) as HTMLElement | null;
            if (!el) return;
            el.focus();
            el.innerHTML = args.msg
              .split("\n")
              .map((line) => `<p>${line}</p>`)
              .join("");
            el.dispatchEvent(new Event("input", { bubbles: true }));
          },
          { sel: inputSelector, msg: message },
        );
      } else {
        await activePage.fill(inputSelector, message);
      }

      await randomDelay(activePage, 200, 500);

      const sendClicked = await activePage.evaluate(() => {
        const selectors = [
          ".submit-content .submit.active",
          ".submit-content .submit",
          ".submit-content",
          ".btn-send",
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel) as HTMLElement | null;
          if (btn && btn.offsetWidth > 0) {
            btn.click();
            return true;
          }
        }
        const spans = Array.from(document.querySelectorAll("span"));
        for (const span of spans) {
          if (span.textContent?.trim() === "发送") {
            (span as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (!sendClicked) {
        return { success: false, sentMessage: message, error: "未找到发送按钮" };
      }

      await randomDelay(activePage, 500, 1200);
      ctx.logger.info("Message sent successfully");
      return { success: true, sentMessage: message };
    } catch (err) {
      return {
        success: false,
        sentMessage: message,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
