import { defineTool } from "@roll-agent/sdk";
import { BrowserAxSnapshotSchema, BrowserPageInfoSchema } from "@roll-agent/browser";
import { z } from "zod";
import { observeBrowserPage } from "../browser-observation.ts";
import {
  getContextManager,
  getRuntime,
  getBrowserInstancePoolOrUndefined,
} from "../runtime-holder.ts";
import { toNativePageInfo } from "../page-info.ts";
import { resolveNativePageForBrowserTool } from "./browser-native-page.ts";
import { createBrowserRefVisualSession } from "./browser-ref-visual.ts";

const BrowserSnapshotInputSchema = z.object({
  scope: z
    .string()
    .max(1000)
    .optional()
    .describe("可选：唯一匹配的 CSS 区域选择器；省略或空白表示整页"),
  pageId: z.string().optional().describe("可选：通过 list_pages 返回的 pageId/native targetId"),
  maxDepth: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("可选：限制 AX Tree 深度；首次观察表单建议省略，深度过小会隐藏字段"),
  maxNodes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("可选：返回节点上限；实际值不会超过 Browser security maxSnapshotNodes"),
  interactiveOnly: z.boolean().default(true).describe("默认 true：只返回可交互节点"),
});

const BrowserSnapshotOutputSchema = z.object({
  page: BrowserPageInfoSchema,
  snapshot: BrowserAxSnapshotSchema,
});

export const browserSnapshot = defineTool({
  name: "browser_snapshot",
  description:
    "观察陌生页面或表单的首选入口：读取 Accessibility Tree，补充独立选项行、控件上下文和覆盖缺口，返回 @eN、snapshotId 和 iframe 的 frameId。省略或空白 scope 表示整页，默认只返回可交互节点。browser_execute 的 page.snapshot() 受 origin 限制不展开 iframe 时，改用本工具；再用 page.ref(ref,snapshotId) 交给 browser_execute 操作，不要猜测 iframe 下标或把外层页面当作完整表单。",
  input: BrowserSnapshotInputSchema,
  output: BrowserSnapshotOutputSchema,
  observationRetention: { kind: "browser-ax-snapshot" },
  execute: async (input, ctx) => {
    const runtime = getRuntime();
    const ctxManager = getContextManager();
    const page = await resolveNativePageForBrowserTool({
      runtime,
      ctxManager,
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
    });

    ctx.logger.info(`Creating browser AX snapshot for page ${page.targetId}`);
    const controller = await runtime.connectNativePage(page);
    const session = createBrowserRefVisualSession(controller);
    try {
      await session.begin("正在读取页面快照");
      const security = runtime.getConfig().security;
      const effectiveMaxNodes = Math.min(
        input.maxNodes ?? security.maxSnapshotNodes,
        security.maxSnapshotNodes,
      );
      const snapshot = await observeBrowserPage({
        controller,
        page,
        browserInstance: getBrowserInstancePoolOrUndefined()?.getBundle().id ?? "default",
        maxNodes: effectiveMaxNodes,
        interactiveOnly: input.interactiveOnly ?? true,
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      });
      await session.succeed(`已识别 ${snapshot.refs.length} 个可操作元素`);

      return {
        page: toNativePageInfo(ctxManager, page),
        snapshot,
      };
    } catch (error) {
      await session.fail("读取页面快照失败");
      throw error;
    } finally {
      controller.close();
    }
  },
});
