import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getSelectedChatTarget } from "../pages/zhipin/chat-target.ts";
import {
  getCurrentZhipinRecruiterIdentity,
  matchesRecruiterBinding,
} from "../pages/zhipin/recruiter-identity.ts";
import { getContextManager } from "../runtime-holder.ts";
import { randomDelay, humanDelay } from "../pages/zhipin/anti-detection.ts";
import { ensureChatListLoaded, ensureChatOpen } from "../pages/zhipin/chat-navigation.ts";
import {
  isReplyEnvelopeConsumed,
  markReplyEnvelopeConsumed,
} from "../reply-authority/replay-store.ts";
import { verifySignedReplyEnvelope } from "../reply-authority/verifier.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  sentMessage: z.string(),
  error: z.string().optional(),
});

export const zhipinSendReply = defineTool({
  name: "zhipin_send_reply",
  description:
    "发送消息。只接受由 Reply Authority Service 签发的 signedEnvelope；可指定 candidateName 自动打开对应聊天后发送，或不传则发送到当前选中的聊天窗口。",
  input: z.object({
    signedEnvelope: z.string().describe("Reply Authority Service 返回的紧凑签名信封"),
    candidateName: z
      .string()
      .optional()
      .describe("候选人姓名。若用户说“回复鲁倩”，这里应提取为“鲁倩”"),
    index: z.number().optional().describe("候选人在列表中的索引（可选）"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    let sentMessage = "";

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    let activePage = page;

    try {
      const envelopePayload = await verifySignedReplyEnvelope(input.signedEnvelope);
      sentMessage = envelopePayload.reply;

      if (isReplyEnvelopeConsumed(envelopePayload.jti)) {
        return { success: false, sentMessage, error: "token 已消费，禁止重放" };
      }

      const nav = await ensureChatOpen(ctxManager, page, {
        candidateName: input.candidateName,
        index: input.index,
      });
      if (nav && !nav.found) {
        return { success: false, sentMessage, error: nav.error };
      }
      if (!nav) {
        const listReady = await ensureChatListLoaded(ctxManager, page);
        if (!listReady) {
          return { success: false, sentMessage, error: "消息列表未加载" };
        }
      }

      activePage = await ctxManager.getPage("zhipin");
      const chatTarget = await getSelectedChatTarget(activePage);
      if (!chatTarget) {
        return {
          success: false,
          sentMessage,
          error: "未能提取当前聊天的 conversationId/candidateId",
        };
      }
      if (
        chatTarget.conversationId !== envelopePayload.conversationId ||
        chatTarget.candidateId !== envelopePayload.candidateId
      ) {
        return { success: false, sentMessage, error: "发送目标与签名不匹配" };
      }

      const recruiterIdentity = await getCurrentZhipinRecruiterIdentity(activePage);
      if (!matchesRecruiterBinding(recruiterIdentity, envelopePayload.recruiterBinding)) {
        return {
          success: false,
          sentMessage,
          error:
            `recruiter 绑定不匹配：当前账号 ${recruiterIdentity.username}` +
            ` 与签发时 ${envelopePayload.recruiterBinding.username} 不一致`,
        };
      }

      ctx.logger.info(
        `Sending message (${sentMessage.length} chars) to ${chatTarget.candidateName || chatTarget.candidateId}`,
      );
      const inputSelector = "#boss-chat-editor-input, textarea.chat-input, .chat-input";
      await activePage.waitForSelector(inputSelector, { timeout: 5_000 });

      const isContentEditable = await activePage.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return el?.getAttribute("contenteditable") === "true";
      }, inputSelector);

      if (isContentEditable) {
        const editor = activePage.locator(inputSelector).first();
        await editor.focus();
        await activePage.evaluate(
          (args: { sel: string; msg: string }) => {
            const el = document.querySelector(args.sel) as HTMLElement | null;
            if (!el) return;
            el.innerHTML = args.msg
              .split("\n")
              .map((line) => `<p>${line}</p>`)
              .join("");
          },
          { sel: inputSelector, msg: sentMessage },
        );
        // 用 Playwright dispatchEvent 触发 input 监听；这仍然是程序派发事件，不是用户真实输入
        await editor.dispatchEvent("input", { bubbles: true });
      } else {
        await activePage.fill(inputSelector, sentMessage);
      }

      await randomDelay(activePage, 200, 500);

      // 查找发送按钮（evaluate 只做定位，不做点击）
      const sendSelector = await activePage.evaluate(() => {
        document.querySelectorAll("[data-roll-send-btn]").forEach((element) => {
          element.removeAttribute("data-roll-send-btn");
        });

        const selectors = [
          ".submit-content .submit.active",
          ".submit-content .submit",
          ".submit-content",
          ".btn-send",
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel) as HTMLElement | null;
          if (btn && btn.offsetWidth > 0) {
            return { found: true as const, selector: sel };
          }
        }
        // fallback: 查找文本为"发送"的 span
        const spans = Array.from(document.querySelectorAll("span"));
        for (const span of spans) {
          if (span.textContent?.trim() === "发送" && span.offsetWidth > 0) {
            span.setAttribute("data-roll-send-btn", "true");
            return { found: true as const, selector: '[data-roll-send-btn="true"]' };
          }
        }
        return { found: false as const };
      });

      if (!sendSelector.found) {
        return { success: false, sentMessage, error: "未找到发送按钮" };
      }

      // Playwright locator 点击（isTrusted: true）
      const sendBtn = activePage.locator(sendSelector.selector).first();
      await sendBtn.scrollIntoViewIfNeeded();
      await sendBtn.hover();
      await humanDelay(activePage);
      await sendBtn.click();

      await randomDelay(activePage, 500, 1200);
      markReplyEnvelopeConsumed(envelopePayload.jti, envelopePayload.exp);
      ctx.logger.info("Message sent successfully");
      return { success: true, sentMessage };
    } catch (err) {
      return {
        success: false,
        sentMessage,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await activePage
        .evaluate(() => {
          document.querySelectorAll("[data-roll-send-btn]").forEach((element) => {
            element.removeAttribute("data-roll-send-btn");
          });
        })
        .catch(() => {});
    }
  },
});
