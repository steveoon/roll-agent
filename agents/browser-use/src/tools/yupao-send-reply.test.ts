import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import {
  BrowserRuntimeConfigSchema,
  type BrowserContextManager,
  type BrowserRuntime,
  type Page,
} from "@roll-agent/browser";
import { resetBrowserActionApprovalsForTests } from "../browser-action-approval.ts";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import { yupaoSendReply } from "./yupao-send-reply.ts";

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

function createPage(calls: string[]): Page {
  return {
    goto: async (url: string) => {
      calls.push(`goto:${url}`);
      return null;
    },
    click: async (selector: string) => {
      calls.push(`click:${selector}`);
    },
    fill: async (selector: string, value: string) => {
      calls.push(`fill:${selector}:${value}`);
    },
    locator: () => {
      throw new Error("locator is not used by yupao_send_reply.");
    },
    content: async () => "",
    textContent: async () => "",
    title: async () => "Yupao",
    url: () => "https://www.yupao.com/chat",
    waitForSelector: async (selector: string) => {
      calls.push(`waitForSelector:${selector}`);
      return {};
    },
  } as unknown as Page;
}

describe("yupao_send_reply", () => {
  afterEach(() => {
    setRuntimeStateForTests({});
    resetBrowserActionApprovalsForTests();
  });

  it("executes a multi-action confirm-gated reply after one tool approval", async () => {
    const calls: string[] = [];
    let getPageCalls = 0;
    const runtime = {
      getConfig() {
        return BrowserRuntimeConfigSchema.parse({
          security: {
            actionPolicy: "confirm",
          },
        });
      },
    } as unknown as BrowserRuntime;
    const ctxManager = {
      async getPage(platform: string) {
        getPageCalls += 1;
        assert.equal(platform, "yupao");
        return createPage(calls);
      },
    } as unknown as BrowserContextManager;

    setRuntimeStateForTests({ runtime, contextManager: ctxManager });

    let approvalId = "";
    await assert.rejects(
      yupaoSendReply.execute(
        { conversationId: "conversation-1", message: "hello" },
        createTestContext(),
      ),
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );
    assert.equal(getPageCalls, 0);
    assert.equal(calls.length, 0);

    const result = await yupaoSendReply.execute(
      {
        conversationId: "conversation-1",
        message: "hello",
        browserActionApproval: { id: approvalId },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(getPageCalls, 1);
    assert.ok(calls.some((call) => call.startsWith("goto:https://www.yupao.com/chat?id=")));
    assert.ok(calls.some((call) => call.includes("fill:")));
    assert.ok(calls.some((call) => call.includes("click:")));
  });
});
