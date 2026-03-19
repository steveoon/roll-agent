import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";

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
        page.frame("recommendFrame") ?? page.frames().find((f) => f.url().includes("recommend"));
      if (!recommendFrame) return { success: false, error: "未找到推荐页 iframe" };

      const resumeFrameHandle = await recommendFrame.$('iframe[src*="c-resume"]');
      if (!resumeFrameHandle) return { success: false, error: "未找到简历 iframe" };

      const resumeFrame = await resumeFrameHandle.contentFrame();
      if (!resumeFrame) return { success: false, error: "无法访问简历 iframe 内容" };

      try {
        await resumeFrame.waitForSelector("canvas#resume, div#resume canvas", { timeout: 5_000 });
      } catch {
        return { success: false, error: "简历 canvas 未加载" };
      }

      const canvasInfo = await resumeFrame.evaluate(() => {
        const canvas = document.querySelector(
          "canvas#resume, div#resume canvas",
        ) as HTMLCanvasElement | null;
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
      });
      if (!canvasInfo) return { success: false, error: "无法获取 canvas 信息" };

      const recommendFrameRect = await page.evaluate(() => {
        const iframe = document.querySelector("#recommendFrame") as HTMLIFrameElement | null;
        if (!iframe) return null;
        const rect = iframe.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });

      const resumeFrameRect = await recommendFrame.evaluate(() => {
        const iframe = document.querySelector(
          'iframe[src*="c-resume"]',
        ) as HTMLIFrameElement | null;
        if (!iframe) return null;
        const rect = iframe.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });

      const offsetX = (recommendFrameRect?.x ?? 0) + (resumeFrameRect?.x ?? 0);
      const offsetY = (recommendFrameRect?.y ?? 0) + (resumeFrameRect?.y ?? 0);

      ctx.logger.info(`Canvas located at (${offsetX + canvasInfo.x}, ${offsetY + canvasInfo.y})`);
      return {
        success: true,
        screenshotArea: {
          x: Math.round(offsetX + canvasInfo.x),
          y: Math.round(offsetY + canvasInfo.y),
          width: Math.round(canvasInfo.clientWidth),
          height: Math.round(canvasInfo.clientHeight),
        },
        canvasInfo: { width: canvasInfo.width, height: canvasInfo.height },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
