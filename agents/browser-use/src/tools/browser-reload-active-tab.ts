import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserPageInfo,
} from "@roll-agent/browser";
import { BrowserActionApprovalSchema, BrowserPageInfoSchema } from "@roll-agent/browser";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import { toNativePageInfo } from "../page-info.ts";
import {
  assertBrowserActionAllowed,
  createBrowserActionPolicyOptions,
} from "../browser-security.ts";
import { maybeBringToFront } from "../browser-foreground.ts";
import { reloadNativePageAndWaitForSwap } from "../native-reload.ts";

const ReloadActiveTabInputSchema = z.object({
  ignoreCache: z
    .boolean()
    .optional()
    .describe("是否绕过缓存强制重新拉取资源（等价 Ctrl+Shift+R），默认 false。"),
  browserActionApproval: BrowserActionApprovalSchema.optional().describe(
    "当 actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
  ),
});

const ReloadActiveTabOutputSchema = z.object({
  success: z.boolean(),
  reloaded: z.boolean(),
  page: BrowserPageInfoSchema,
});

type ReloadActiveTabDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly getRuntime: typeof getRuntime;
  readonly toNativePageInfo: typeof toNativePageInfo;
  readonly reloadNativePageAndWaitForSwap: typeof reloadNativePageAndWaitForSwap;
};

let reloadActiveTabDepsOverride: Partial<ReloadActiveTabDeps> | undefined;

function getReloadActiveTabDeps(): ReloadActiveTabDeps {
  return {
    getContextManager,
    getRuntime,
    toNativePageInfo,
    reloadNativePageAndWaitForSwap,
    ...reloadActiveTabDepsOverride,
  };
}

export function setReloadActiveTabDepsForTests(
  override: Partial<ReloadActiveTabDeps> | undefined,
): void {
  reloadActiveTabDepsOverride = override;
}

function resolveActiveNativePage(
  ctxManager: BrowserContextManager,
  pages: readonly BrowserInspectablePage[],
): BrowserInspectablePage {
  const selected = pages.filter((page) => ctxManager.isNativePageSelected(page.targetId));
  if (selected.length === 1) {
    const page = selected[0];
    if (page) {
      return page;
    }
  }
  if (selected.length > 1) {
    throw new Error("Multiple selected native tabs found; select a single tab before reloading.");
  }
  if (pages.length === 1) {
    const page = pages[0];
    if (page) {
      return page;
    }
  }
  if (pages.length === 0) {
    throw new Error("No native page is open; navigate before reloading.");
  }
  throw new Error(
    "Multiple native pages are open and none is selected; select the target tab before reloading.",
  );
}

export const browserReloadActiveTab = defineTool({
  name: "browser_reload_active_tab",
  description:
    "对当前 tracked native page 执行 CDP Page.reload，清空页面内 DOM 与 SPA 状态后等待文档完成换页；不触发 Playwright attach，走现有 actionPolicy / domainAllowlist 边界。",
  input: ReloadActiveTabInputSchema,
  output: ReloadActiveTabOutputSchema,
  execute: async (input, ctx) => {
    const deps = getReloadActiveTabDeps();
    const ctxManager = deps.getContextManager();
    const runtime = deps.getRuntime();

    const target = resolveActiveNativePage(ctxManager, await runtime.listNativePages());
    const guard = assertBrowserActionAllowed(ctx, runtime, {
      action: "navigate",
      target: target.url,
      url: target.url,
      ...(input.browserActionApproval !== undefined
        ? { approval: input.browserActionApproval }
        : {}),
    });
    ctx.logger.info(`Reloading native tab ${target.targetId} (${target.url})`);

    const controller = await runtime.connectNativePage(target, {
      ...createBrowserActionPolicyOptions(ctx, runtime, {
        approval: input.browserActionApproval,
        approvedByConfirmation: guard.approvedByConfirmation,
        logActions: false,
      }),
    });

    try {
      await maybeBringToFront(
        {
          targetId: target.targetId,
          bringToFront: async () => {
            await controller.bringToFront();
          },
        },
        { runtime },
      );
      await deps.reloadNativePageAndWaitForSwap(controller, {
        url: target.url,
        ...(input.ignoreCache !== undefined ? { ignoreCache: input.ignoreCache } : {}),
      });

      const refreshedPage =
        (await runtime.listNativePages()).find(
          (candidate) => candidate.targetId === target.targetId,
        ) ?? target;

      return {
        success: true,
        reloaded: true,
        page: deps.toNativePageInfo(ctxManager, refreshedPage) satisfies BrowserPageInfo,
      };
    } finally {
      controller.close();
    }
  },
});
