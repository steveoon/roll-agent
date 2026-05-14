import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Page } from "playwright-core";
import { BrowserSecurityConfigSchema } from "../types/index.ts";
import { BrowserActionPolicyError } from "../runtime/security.ts";
import { clickElement, navigateTo, snapshot, typeText } from "./page-actions.ts";

describe("page actions", () => {
  it("returns truncation metadata when snapshot html exceeds maxContentBytes", async () => {
    const page = {
      url: () => "https://example.com",
      title: async () => "Example",
      content: async () => "abc你好",
    } as unknown as Page;

    const result = await snapshot(page, { maxContentBytes: 4 });

    assert.equal(result.url, "https://example.com");
    assert.equal(result.title, "Example");
    assert.equal(result.html, "abc");
    assert.equal(result.truncated, true);
    assert.equal(result.originalBytes, 9);
    assert.equal(result.returnedBytes, 3);
  });

  it("applies optional action policy before Playwright page actions", async () => {
    const calls: string[] = [];
    const page = {
      goto: async () => {
        calls.push("goto");
      },
      click: async () => {
        calls.push("click");
      },
      fill: async () => {
        calls.push("fill");
      },
    } as unknown as Page;
    const security = BrowserSecurityConfigSchema.parse({ actionPolicy: "deny" });

    await assert.rejects(
      navigateTo(page, "https://example.com", { security }),
      BrowserActionPolicyError,
    );
    await assert.rejects(clickElement(page, "button", { security }), BrowserActionPolicyError);
    await assert.rejects(typeText(page, "input", "hello", { security }), BrowserActionPolicyError);
    assert.deepEqual(calls, []);
  });
});
