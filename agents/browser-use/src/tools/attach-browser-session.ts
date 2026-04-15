import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getRuntime } from "../runtime-holder.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  mode: z.string(),
  connected: z.boolean(),
});

export const attachBrowserSession = defineTool({
  name: "attach_browser_session",
  description: "调试工具：显式执行一次 connectOverCDP()，仅建立 Playwright Browser 连接，不做页面导航或 DOM 操作。",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    const runtime = getRuntime();

    ctx.logger.info("Attaching Playwright browser session over CDP");

    await runtime.getBrowser();

    return {
      success: true,
      mode: runtime.mode,
      connected: true,
    };
  },
});
