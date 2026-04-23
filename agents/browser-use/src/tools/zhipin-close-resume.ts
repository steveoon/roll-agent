import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../visual-cursor.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  closed: z.boolean(),
  error: z.string().optional(),
});

// 旧代码使用的关闭按钮选择器（boss-popup__close 系列）
const CLOSE_SELECTORS_IFRAME = [
  ".recommendV2 .boss-popup__close",
  ".dialog-lib-resume .boss-popup__close",
  ".boss-dialog .boss-popup__close",
  ".boss-popup__close",
  ".close-btn",
  ".dialog-close",
] as const;

const CLOSE_SELECTORS_PAGE = [
  ".boss-popup__close",
  ".close-btn",
  ".dialog-close",
  ".modal-close",
] as const;

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
      page.frame("recommendFrame") ?? page.frames().find((f) => f.url().includes("recommend"));

    const closed = await (async () => {
      // 优先在 iframe 中查找
      if (frame) {
        for (const sel of CLOSE_SELECTORS_IFRAME) {
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
      for (const sel of CLOSE_SELECTORS_PAGE) {
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
        ? await frame.$(".boss-popup__wrapper, .dialog-lib-resume, .boss-dialog")
        : await page.$(".boss-popup__wrapper");
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
