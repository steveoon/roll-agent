import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  composeResumeCanvasArea,
  ZHIPIN_RESUME_CANVAS_SELECTOR,
  ZHIPIN_RESUME_IFRAME_SELECTOR,
  ZHIPIN_RESUME_RECOMMEND_FRAME_NAME,
  ZHIPIN_RESUME_RECOMMEND_FRAME_SELECTOR,
  ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER,
} from "../pages/zhipin/resume-dom-contract.ts";

const CanvasPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  screenshotArea: CanvasPositionSchema.optional(),
  canvasInfo: z.object({ width: z.number(), height: z.number() }).optional(),
  error: z.string().optional(),
});

export const zhipinLocateResumeCanvas = defineTool({
  name: "zhipin_locate_resume_canvas",
  description: "定位简历详情中嵌套 iframe 内的 canvas 元素坐标（用于截图）",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Locating resume canvas in nested iframes");

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    try {
      const recommendFrame =
        page.frame(ZHIPIN_RESUME_RECOMMEND_FRAME_NAME) ??
        page
          .frames()
          .find((frame) => frame.url().includes(ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER));
      if (!recommendFrame) return { success: false, error: "未找到推荐页 iframe" };

      const resumeFrameHandle = await recommendFrame.$(ZHIPIN_RESUME_IFRAME_SELECTOR);
      if (!resumeFrameHandle) return { success: false, error: "未找到简历 iframe" };

      const resumeFrame = await resumeFrameHandle.contentFrame();
      if (!resumeFrame) return { success: false, error: "无法访问简历 iframe 内容" };

      try {
        await resumeFrame.waitForSelector(ZHIPIN_RESUME_CANVAS_SELECTOR, { timeout: 5_000 });
      } catch {
        return { success: false, error: "简历 canvas 未加载" };
      }

      const canvasInfo = await resumeFrame.evaluate((canvasSelector: string) => {
        const canvas = document.querySelector(canvasSelector) as HTMLCanvasElement | null;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return {
          width: canvas.width,
          height: canvas.height,
          clientWidth: rect.width,
          clientHeight: rect.height,
          x: rect.x,
          y: rect.y,
        };
      }, ZHIPIN_RESUME_CANVAS_SELECTOR);
      if (!canvasInfo) return { success: false, error: "无法获取 canvas 信息" };

      const recommendFrameRect = await page.evaluate((frameSelector: string) => {
        const iframe = document.querySelector(frameSelector) as HTMLIFrameElement | null;
        if (!iframe) return null;
        const rect = iframe.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      }, ZHIPIN_RESUME_RECOMMEND_FRAME_SELECTOR);

      const resumeFrameRect = await recommendFrame.evaluate((resumeIframeSelector: string) => {
        const iframe = document.querySelector(resumeIframeSelector) as HTMLIFrameElement | null;
        if (!iframe) return null;
        const rect = iframe.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      }, ZHIPIN_RESUME_IFRAME_SELECTOR);

      const screenshotArea = composeResumeCanvasArea({
        recommendFrameRect,
        resumeFrameRect,
        canvasRect: {
          x: canvasInfo.x,
          y: canvasInfo.y,
          width: canvasInfo.clientWidth,
          height: canvasInfo.clientHeight,
        },
      });

      ctx.logger.info(`Canvas located at (${screenshotArea.x}, ${screenshotArea.y})`);
      return {
        success: true,
        screenshotArea,
        canvasInfo: { width: canvasInfo.width, height: canvasInfo.height },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
