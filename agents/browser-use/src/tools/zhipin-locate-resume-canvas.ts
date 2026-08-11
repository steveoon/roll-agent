import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";

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

type ZhipinLocateResumeCanvasDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
};

let zhipinLocateResumeCanvasDepsOverride: Partial<ZhipinLocateResumeCanvasDeps> | undefined;

function getZhipinLocateResumeCanvasDeps(): ZhipinLocateResumeCanvasDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    ...zhipinLocateResumeCanvasDepsOverride,
  };
}

export function setZhipinLocateResumeCanvasDepsForTests(
  override: Partial<ZhipinLocateResumeCanvasDeps> | undefined,
): void {
  zhipinLocateResumeCanvasDepsOverride = override;
}

export const zhipinLocateResumeCanvas = defineTool({
  name: "zhipin_locate_resume_canvas",
  description: "定位简历详情中嵌套 iframe 内的 canvas 元素坐标（用于截图）",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Locating resume canvas through native backend");

    const deps = getZhipinLocateResumeCanvasDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    try {
      nativePage = await deps.openNativePagePort();
      const capture = await nativePage.captureResumeCanvas();
      if (!capture.found || capture.screenshotArea === undefined || capture.canvasSize === undefined) {
        return { success: false, error: capture.error ?? "未找到简历 canvas" };
      }

      ctx.logger.info(
        `Canvas located at (${String(capture.screenshotArea.x)}, ${String(capture.screenshotArea.y)})`,
      );
      return {
        success: true,
        screenshotArea: capture.screenshotArea,
        canvasInfo: capture.canvasSize,
      };
    } finally {
      nativePage?.close();
    }
  },
});
