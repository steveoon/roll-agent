import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StructuredToolError } from "@roll-agent/sdk";
import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
} from "@roll-agent/browser";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import { resetBrowserActionApprovalsForTests } from "../browser-action-approval.ts";
import { openPlatform } from "./open-platform.ts";
import type { AgentContext } from "@roll-agent/sdk";

function createTestContext(): AgentContext {
  return {
    llm: {
      generateText: async () => "",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

function createNativePage(targetId: string, url: string): BrowserInspectablePage {
  return {
    targetId,
    type: "page",
    url,
    title: "",
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${targetId}`,
  };
}

function readApprovalIdFromError(error: unknown): string {
  assert.ok(error instanceof StructuredToolError);
  const details = error.payload.details;
  assert.ok(details !== undefined);
  const approvalRequest = details["approvalRequest"];
  assert.equal(typeof approvalRequest, "object");
  assert.notEqual(approvalRequest, null);
  assert.equal(typeof (approvalRequest as Record<string, unknown>)["id"], "string");
  return (approvalRequest as { id: string }).id;
}

describe("open_platform", () => {
  afterEach(() => {
    setRuntimeStateForTests({});
    resetBrowserActionApprovalsForTests();
  });

  it("applies action policy before native page operations", async () => {
    const openedUrls: string[] = [];
    const activatedTargets: string[] = [];
    const runtime = {
      getConfig() {
        return BrowserRuntimeConfigSchema.parse({
          security: {
            actionPolicy: "deny",
          },
        });
      },
      async listNativePages() {
        return [];
      },
      async activateNativePage(targetId: string) {
        activatedTargets.push(targetId);
      },
      async openNativePage(url: string) {
        openedUrls.push(url);
        return createNativePage("target-opened", url);
      },
    } as unknown as BrowserRuntime;
    const ctxManager = {
      rememberNativePageSelection() {},
      getBoundPlatformForNativePage() {
        return undefined;
      },
      isNativePageSelected() {
        return false;
      },
    } as unknown as BrowserContextManager;

    setRuntimeStateForTests({ runtime, contextManager: ctxManager });

    await assert.rejects(
      openPlatform.execute({ platform: "zhipin" }, createTestContext()),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "action_denied");
        return true;
      },
    );

    assert.deepEqual(openedUrls, []);
    assert.deepEqual(activatedTargets, []);
  });

  it("executes confirm-gated open after orchestrator returns approval", async () => {
    const openedUrls: string[] = [];
    const runtime = {
      getConfig() {
        return BrowserRuntimeConfigSchema.parse({
          security: {
            actionPolicy: "confirm",
          },
        });
      },
      async listNativePages() {
        return [];
      },
      async activateNativePage() {},
      async openNativePage(url: string) {
        openedUrls.push(url);
        return createNativePage("target-opened", url);
      },
    } as unknown as BrowserRuntime;
    const ctxManager = {
      rememberNativePageSelection() {},
      getBoundPlatformForNativePage() {
        return undefined;
      },
      isNativePageSelected() {
        return false;
      },
    } as unknown as BrowserContextManager;

    setRuntimeStateForTests({ runtime, contextManager: ctxManager });

    let approvalId = "";
    await assert.rejects(
      openPlatform.execute({ platform: "zhipin" }, createTestContext()),
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    const result = await openPlatform.execute(
      {
        platform: "zhipin",
        browserActionApproval: { id: approvalId },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(openedUrls, ["https://www.zhipin.com"]);
  });
});
