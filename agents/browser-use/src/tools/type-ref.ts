import { StructuredToolError, defineTool } from "@roll-agent/sdk";
import {
  BrowserActionApprovalSchema,
  BrowserElementRefHandleSchema,
  typeElementRef,
} from "@roll-agent/browser";
import { z } from "zod";
import { browserElementRefStore } from "../element-ref-store.ts";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import {
  assertBrowserActionAllowed,
  createBrowserActionPolicyOptions,
  toStructuredBrowserActionError,
} from "../browser-security.ts";
import { resolveNativePageForBrowserTool } from "./browser-native-page.ts";
import { BrowserElementRefActionOutputSchema } from "./browser-ref-schemas.ts";
import {
  clickBrowserRefVisualTarget,
  createBrowserRefVisualSession,
} from "./browser-ref-visual.ts";

const TypeRefInputSchema = z.object({
  ref: BrowserElementRefHandleSchema.describe("browser_snapshot 返回的 @eN element ref"),
  text: z.string().describe("要输入的文本"),
  clear: z.boolean().default(false).describe("输入前是否先清空当前控件内容"),
  pageId: z.string().optional().describe("可选：通过 list_pages 返回的 pageId/native targetId"),
  browserActionApproval: BrowserActionApprovalSchema.optional().describe(
    "当 actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
  ),
});

export const typeRef = defineTool({
  name: "type_ref",
  description:
    "向 browser_snapshot 返回的 @eN ref 输入文本；优先使用 backendNodeId，失效时使用 role/name/nth fallback。",
  input: TypeRefInputSchema,
  output: BrowserElementRefActionOutputSchema,
  execute: async (input, ctx) => {
    const runtime = getRuntime();
    const ctxManager = getContextManager();
    const page = await resolveNativePageForBrowserTool({
      runtime,
      ctxManager,
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
    });
    const elementRef = browserElementRefStore.getRef(page.targetId, input.ref);
    if (elementRef === undefined) {
      throw new StructuredToolError({
        code: "not_found",
        message: `Element ref ${input.ref} is not available. Run browser_snapshot for this page first.`,
        details: {
          ref: input.ref,
          pageId: page.targetId,
        },
      });
    }

    const guard = assertBrowserActionAllowed(ctx, runtime, {
      action: "type",
      target: input.ref,
      ...(input.browserActionApproval !== undefined
        ? { approval: input.browserActionApproval }
        : {}),
    });

    const controller = await runtime.connectNativePage(page, {
      ...createBrowserActionPolicyOptions(ctx, runtime, {
        approval: input.browserActionApproval,
        approvedByConfirmation: guard.approvedByConfirmation,
        logActions: false,
      }),
    });
    try {
      await controller.bringToFront().catch(() => {});
      const session = createBrowserRefVisualSession(controller);
      await session.begin(`正在输入到 ${input.ref}`);
      const result = await typeElementRef({
        controller,
        elementRef,
        text: input.text,
        options: {
          ...(input.clear !== undefined ? { clear: input.clear } : {}),
          clickTarget: async (target) => {
            await clickBrowserRefVisualTarget(controller, session, target);
          },
        },
      });
      await session.succeed(`已输入到 ${input.ref}`);
      return result;
    } catch (error) {
      await createBrowserRefVisualSession(controller).fail(`输入到 ${input.ref} 失败`);
      const structured = toStructuredBrowserActionError(error);
      if (structured !== undefined) {
        throw structured;
      }
      throw error;
    } finally {
      controller.close();
    }
  },
});
