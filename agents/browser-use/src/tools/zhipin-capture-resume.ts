import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type {
  NativeResumeStitchProgress,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const OutputSchema = z.object({
  success: z.boolean(),
  imagePath: z.string().optional(),
  captureMode: z.enum(["canvas-data-url", "viewport-clip", "dom-screenshot"]).optional(),
  canvasSize: z.object({ width: z.number(), height: z.number() }).optional(),
  note: z.string().optional(),
  error: z.string().optional(),
  mcpImages: z
    .array(z.object({ data: z.string(), mimeType: z.string() }))
    .optional()
    .describe("截图的 MCP image content（base64）；由 SDK 转为 image block 返回，调用方无需解析"),
});

type ZhipinCaptureResumeDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly writePngFile: (path: string, base64Data: string) => Promise<void>;
  readonly now: () => number;
};

let zhipinCaptureResumeDepsOverride: Partial<ZhipinCaptureResumeDeps> | undefined;

function getZhipinCaptureResumeDeps(): ZhipinCaptureResumeDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    writePngFile: async (path, base64Data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(base64Data, "base64"));
    },
    now: () => Date.now(),
    ...zhipinCaptureResumeDepsOverride,
  };
}

export function setZhipinCaptureResumeDepsForTests(
  override: Partial<ZhipinCaptureResumeDeps> | undefined,
): void {
  zhipinCaptureResumeDepsOverride = override;
}

export const zhipinCaptureResume = defineTool({
  name: "zhipin_capture_resume",
  description:
    "截取当前打开的简历详情弹窗中的 canvas 简历为 PNG 图片文件并返回 imagePath。简历内容是 canvas 图像渲染，无法从 DOM/文本读取；编排器应在调用后用自身的多模态图像能力读取该文件来理解简历内容。需先用 zhipin_open_resume 打开简历弹窗",
  input: z.object({
    outputPath: z
      .string()
      .min(1)
      .refine((value) => isAbsolute(value), { message: "outputPath 必须是绝对路径" })
      .optional()
      .describe("PNG 输出文件的绝对路径；缺省时写入系统临时目录"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info("Capturing resume canvas through native backend");

    const deps = getZhipinCaptureResumeDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySession | undefined;
    try {
      nativePage = await deps.openNativePagePort();
      session = new NativeVisualActivitySession(nativePage);
      await session.begin("正在读取简历");

      const dialogState = await nativePage.waitForResumeDialog(12_000);
      if (!dialogState.iframeFound) {
        await session.fail("简历弹窗未打开");
        return { success: false, error: "简历弹窗未打开，请先调用 zhipin_open_resume" };
      }
      if (!dialogState.canvasReady) {
        await session.fail("简历内容未加载完成");
        return { success: false, error: "简历 canvas 未加载完成，请稍后重试" };
      }

      const capture = await nativePage.captureResumeCanvas(async (progress) => {
        await session?.begin(formatStitchProgressLabel(progress));
      });
      if (!capture.found || capture.canvasSize === undefined) {
        await session.fail("未找到简历内容");
        return { success: false, error: capture.error ?? "未找到简历 canvas" };
      }
      await nativePage.assertNotRestricted();

      let pngBase64: string;
      let captureMode: "canvas-data-url" | "viewport-clip" | "dom-screenshot";
      let note: string | undefined;
      if (
        capture.blank !== true &&
        capture.dataUrl !== undefined &&
        capture.dataUrl.startsWith(PNG_DATA_URL_PREFIX)
      ) {
        pngBase64 = capture.dataUrl.slice(PNG_DATA_URL_PREFIX.length);
        captureMode = "canvas-data-url";
      } else if (capture.blank === true) {
        const dialogArea = await nativePage.readResumeDialogClipArea();
        if (dialogArea === undefined) {
          await session.fail("未找到简历弹窗区域");
          return { success: false, error: "简历 canvas 为空白且未找到弹窗区域，无法截图" };
        }
        await hideVisualBeforeScreenshot(session);
        pngBase64 = await nativePage.captureViewportClip(dialogArea, 2);
        captureMode = "dom-screenshot";
        note =
          "此简历为 DOM 文本渲染（canvas 为空），已改为截取弹窗可见区域；若弹窗内有滚动内容可能未完整覆盖";
      } else {
        if (capture.screenshotArea === undefined) {
          await session.fail("简历坐标不完整");
          return { success: false, error: "简历 canvas 坐标不完整，无法截图" };
        }
        await hideVisualBeforeScreenshot(session);
        pngBase64 = await nativePage.captureViewportClip(capture.screenshotArea);
        captureMode = "viewport-clip";
        note = `canvas.toDataURL 不可用${capture.dataUrlError !== undefined ? `（${capture.dataUrlError}）` : ""}，已回退为视口区域截图，超出可视区的简历内容可能被截断`;
      }

      const imagePath =
        input.outputPath ?? join(tmpdir(), "roll-browser-use", `resume-${String(deps.now())}.png`);
      await deps.writePngFile(imagePath, pngBase64);

      await session.succeed("简历读取完成");
      ctx.logger.info(`Resume captured to ${imagePath} (${captureMode})`);
      return {
        success: true,
        imagePath,
        captureMode,
        canvasSize: capture.canvasSize,
        ...(note !== undefined ? { note } : {}),
        mcpImages: [{ data: pngBase64, mimeType: "image/png" }],
      };
    } catch (error) {
      rethrowStructuredToolError(error);
      await session?.fail("简历读取失败");
      ctx.logger.warn(
        `Native zhipin capture resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, error: "简历读取失败，请重试" };
    } finally {
      nativePage?.close();
    }
  },
});

const VISUAL_FADE_OUT_MS = 240;

function formatStitchProgressLabel(progress: NativeResumeStitchProgress): string {
  if (progress.totalPx > 0) {
    const percent = Math.min(99, Math.round((progress.scrolledPx / progress.totalPx) * 100));
    if (percent > 0) {
      return `正在读取简历 ${String(percent)}%`;
    }
    return "正在读取简历";
  }
  return `正在读取简历 · 第 ${String(progress.round + 1)} 屏`;
}

async function hideVisualBeforeScreenshot(session: NativeVisualActivitySession): Promise<void> {
  const cleared = await session.clear();
  if (cleared) {
    await new Promise((resolve) => setTimeout(resolve, VISUAL_FADE_OUT_MS));
  }
}
