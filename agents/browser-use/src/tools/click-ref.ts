import { StructuredToolError, defineTool } from "@roll-agent/sdk";
import {
  BrowserActionApprovalSchema,
  BrowserElementRefHandleSchema,
  clickElementRef,
} from "@roll-agent/browser";
import { z } from "zod";
import { browserElementRefStore } from "../element-ref-store.ts";
import {
  getContextManager,
  getRuntime,
  getBrowserInstancePoolOrUndefined,
} from "../runtime-holder.ts";
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
import { readBrowserDocumentIdentity } from "../browser-observation.ts";
import { maybeBringToFront } from "../browser-foreground.ts";
import { createBrowserRefFrameGuard } from "./browser-ref-frame-guard.ts";

const ClickRefInputSchema = z.object({
  ref: BrowserElementRefHandleSchema.describe("browser_snapshot 返回的 @eN element ref"),
  snapshotId: z.string().optional().describe("严格绑定 browser_snapshot；过期快照或文档变更时停止"),
  pageId: z.string().optional().describe("可选：通过 list_pages 返回的 pageId/native targetId"),
  browserActionApproval: BrowserActionApprovalSchema.optional().describe(
    "当 actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
  ),
});

export const clickRef = defineTool({
  name: "click_ref",
  description:
    "点击 browser_snapshot 返回的 @eN ref；优先使用 backendNodeId，失效时使用 role/name/nth fallback。",
  input: ClickRefInputSchema,
  output: BrowserElementRefActionOutputSchema,
  execute: async (input, ctx) => {
    const runtime = getRuntime();
    const ctxManager = getContextManager();
    const page = await resolveNativePageForBrowserTool({
      runtime,
      ctxManager,
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
    });
    let elementRef = browserElementRefStore.getRef(page.targetId, input.ref);
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
      action: "click",
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
      if (input.snapshotId !== undefined) {
        elementRef = browserElementRefStore.getScopedRef({
          browserInstance: getBrowserInstancePoolOrUndefined()?.getBundle().id ?? "default",
          pageId: page.targetId,
          snapshotId: input.snapshotId,
          documentId: await readBrowserDocumentIdentity(controller),
          ref: input.ref,
        });
        if (elementRef === undefined) {
          throw new StructuredToolError({
            code: "not_found",
            message:
              "Snapshot ref is stale or belongs to another page/instance. Run browser_snapshot again.",
          });
        }
      }
      await maybeBringToFront(
        {
          targetId: page.targetId,
          bringToFront: async () => {
            await controller.bringToFront();
          },
        },
        { runtime },
      );
      const session = createBrowserRefVisualSession(controller);
      const actionController = createBrowserRefFrameGuard(controller, {
        ...(elementRef.frameId === undefined ? {} : { frameId: elementRef.frameId }),
        runtime,
        approvedByConfirmation: guard.approvedByConfirmation,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      await session.begin(`正在点击 ${input.ref}`);
      const result = await clickElementRef({
        controller: actionController,
        elementRef,
        options: {
          clickTarget: async (target) => {
            await clickBrowserRefVisualTarget(actionController, session, target);
          },
        },
      });
      await session.succeed(`已点击 ${input.ref}`);
      return result;
    } catch (error) {
      await createBrowserRefVisualSession(controller).fail(`点击 ${input.ref} 失败`);
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
