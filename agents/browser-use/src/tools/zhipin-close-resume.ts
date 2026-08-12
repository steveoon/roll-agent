import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  closed: z.boolean(),
  method: z.enum(["close-button", "escape"]).optional(),
  error: z.string().optional(),
});

type ZhipinCloseResumeDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
};

let zhipinCloseResumeDepsOverride: Partial<ZhipinCloseResumeDeps> | undefined;

function getZhipinCloseResumeDeps(): ZhipinCloseResumeDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    ...zhipinCloseResumeDepsOverride,
  };
}

export function setZhipinCloseResumeDepsForTests(
  override: Partial<ZhipinCloseResumeDeps> | undefined,
): void {
  zhipinCloseResumeDepsOverride = override;
}

export const zhipinCloseResume = defineTool({
  name: "zhipin_close_resume",
  description: "关闭简历详情弹窗",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Closing resume detail modal through native backend");

    const deps = getZhipinCloseResumeDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    try {
      nativePage = await deps.openNativePagePort();
      const result = await nativePage.closeResumeDialog();
      if (!result.closed) {
        return { success: false, closed: false, error: result.error ?? "简历弹窗未关闭" };
      }

      ctx.logger.info(`Resume modal closed via ${result.method ?? "unknown"}`);
      return {
        success: true,
        closed: true,
        ...(result.method !== undefined ? { method: result.method } : {}),
      };
    } finally {
      nativePage?.close();
    }
  },
});
