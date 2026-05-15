import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BrowserActionPolicyError,
  BrowserSecurityConfigSchema,
  type Page,
} from "@roll-agent/browser";
import { sendReply } from "./chat.ts";

function createPage(): {
  readonly page: Page;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const location = {
    url: "https://www.yupao.com/im",
    title: "Yupao",
  };
  const page = {
    goto: async (url: string) => {
      calls.push(`goto:${url}`);
      return location;
    },
    click: async (selector: string) => {
      calls.push(`click:${selector}`);
    },
    fill: async (selector: string, value: string) => {
      calls.push(`fill:${selector}:${value}`);
    },
    locator: () => {
      throw new Error("locator is not used by sendReply.");
    },
    content: async () => {
      calls.push("content");
      return "";
    },
    textContent: async () => {
      calls.push("textContent");
      return "";
    },
    title: async () => location.title,
    url: () => location.url,
    waitForSelector: async (selector: string) => {
      calls.push(`waitForSelector:${selector}`);
      return {};
    },
  } as unknown as Page;

  return {
    calls,
    page,
  };
}

describe("yupao chat", () => {
  it("rethrows browser action policy errors before mutating the page", async () => {
    const { page, calls } = createPage();
    const security = BrowserSecurityConfigSchema.parse({
      actionPolicy: "deny",
    });

    await assert.rejects(
      sendReply(page, "conversation-1", "hello", { security }),
      BrowserActionPolicyError,
    );
    assert.deepEqual(calls, []);
  });
});
