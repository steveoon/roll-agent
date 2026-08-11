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
      const dialogState = await nativePage.waitForResumeDialog(5_000);
      if (!dialogState.iframeFound) {
        return { success: false, error: "简历弹窗未打开，请先调用 zhipin_open_resume" };
      }
      if (!dialogState.canvasReady) {
        return { success: false, error: "简历 canvas 未加载完成，请稍后重试" };
      }

      const geometry = await nativePage.readResumeCanvasGeometry();
      if (
        !geometry.found ||
        geometry.screenshotArea === undefined ||
        geometry.canvasSize === undefined
      ) {
        return { success: false, error: geometry.error ?? "未找到简历 canvas" };
      }

      ctx.logger.info(
        `Canvas located at (${String(geometry.screenshotArea.x)}, ${String(geometry.screenshotArea.y)})`,
      );
      return {
        success: true,
        screenshotArea: geometry.screenshotArea,
        canvasInfo: geometry.canvasSize,
      };
    } catch (error) {
      ctx.logger.warn(
        `Native zhipin locate resume canvas failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, error: "定位简历 canvas 失败" };
    } finally {
      nativePage?.close();
    }
  },
});
