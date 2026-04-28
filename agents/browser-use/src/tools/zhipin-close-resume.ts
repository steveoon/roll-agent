import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  ZHIPIN_RESUME_DIALOG_SELECTOR,
  ZHIPIN_RESUME_IFRAME_CLOSE_SELECTORS,
  ZHIPIN_RESUME_PAGE_CLOSE_SELECTORS,
  ZHIPIN_RESUME_PAGE_DIALOG_SELECTOR,
  ZHIPIN_RESUME_RECOMMEND_FRAME_NAME,
  ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER,
} from "../pages/zhipin/resume-dom-contract.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  closed: z.boolean(),
  error: z.string().optional(),
});

export const zhipinCloseResume = defineTool({
  name: "zhipin_close_resume",
  description: "关闭简历详情弹窗",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Closing resume detail modal");

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    const frame =
      page.frame(ZHIPIN_RESUME_RECOMMEND_FRAME_NAME) ??
      page.frames().find((frame) => frame.url().includes(ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER));

    const closed = await (async () => {
      // 优先在 iframe 中查找
      if (frame) {
        for (const sel of ZHIPIN_RESUME_IFRAME_CLOSE_SELECTORS) {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible()) {
            await moveVisualCursorToLocator(page, btn, { target: frame });
            await showVisualClickOnLocator(page, btn, { target: frame });
            await btn.click();
            return true;
          }
        }
      }

      // 回退到主页面
      for (const sel of ZHIPIN_RESUME_PAGE_CLOSE_SELECTORS) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible()) {
          await moveVisualCursorToLocator(page, btn);
          await showVisualClickOnLocator(page, btn);
          await btn.click();
          return true;
        }
      }
      return false;
    })();

    if (!closed) return { success: false, closed: false, error: "未找到关闭按钮" };

    // 验证关闭（轮询）
    let verified = false;
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(300);
      const dialogExists = frame
        ? await frame.$(ZHIPIN_RESUME_DIALOG_SELECTOR)
        : await page.$(ZHIPIN_RESUME_PAGE_DIALOG_SELECTOR);
      if (!dialogExists || !(await dialogExists.isVisible())) {
        verified = true;
        break;
      }
    }

    ctx.logger.info(
      verified ? "Resume modal closed and verified" : "Resume modal close unverified",
    );
    return { success: true, closed: true };
  },
});
