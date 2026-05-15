import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserSecurityConfigSchema } from "../types/index.ts";
import {
  assertBrowserActionPreflight,
  BrowserActionPolicyError,
  isUrlAllowedByDomainAllowlist,
  preflightBrowserAction,
  truncateTextToUtf8Bytes,
} from "./security.ts";

describe("browser security helpers", () => {
  it("matches exact and subdomain hosts without allowing lookalikes", () => {
    const allowlist = ["zhipin.com"];

    assert.equal(isUrlAllowedByDomainAllowlist("https://zhipin.com", allowlist), true);
    assert.equal(isUrlAllowedByDomainAllowlist("https://www.zhipin.com", allowlist), true);
    assert.equal(isUrlAllowedByDomainAllowlist("https://evilzhipin.com", allowlist), false);
    assert.equal(isUrlAllowedByDomainAllowlist("file:///tmp/page.html", allowlist), false);
    assert.equal(isUrlAllowedByDomainAllowlist("not a url", allowlist), false);
    assert.equal(isUrlAllowedByDomainAllowlist("not a url", []), true);
  });

  it("returns structured action policy decisions", () => {
    const deny = preflightBrowserAction({
      security: BrowserSecurityConfigSchema.parse({ actionPolicy: "deny" }),
      action: "navigate",
      target: "https://example.com",
      url: "https://example.com",
    });
    assert.equal(deny.ok, false);
    assert.equal(deny.code, "action_denied");

    const confirm = preflightBrowserAction({
      security: BrowserSecurityConfigSchema.parse({ actionPolicy: "confirm" }),
      action: "navigate",
      target: "https://example.com",
      url: "https://example.com",
    });
    assert.equal(confirm.ok, false);
    assert.equal(confirm.code, "needs_confirmation");
  });

  it("denies urls outside the domain allowlist before action policy", () => {
    const result = preflightBrowserAction({
      security: BrowserSecurityConfigSchema.parse({
        domainAllowlist: ["zhipin.com"],
        actionPolicy: "confirm",
      }),
      action: "navigate",
      target: "https://example.com",
      url: "https://example.com",
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "action_denied");
    assert.equal(result.details.reason, "domain_not_allowed");
  });

  it("accepts matching browser action approval for confirm policy", () => {
    const security = BrowserSecurityConfigSchema.parse({ actionPolicy: "confirm" });

    assert.doesNotThrow(() => {
      assertBrowserActionPreflight({
        security,
        action: "navigate",
        target: "https://example.com",
        url: "https://example.com",
        approval: { id: "approval-1" },
        approveAction: ({ approval, details }) =>
          approval.id === "approval-1" &&
          details.action === "navigate" &&
          details.target === "https://example.com",
      });
    });

    assert.throws(() => {
      assertBrowserActionPreflight({
        security,
        action: "navigate",
        target: "https://example.com",
        url: "https://example.com",
        approval: { id: "approval-2" },
        approveAction: () => false,
      });
    }, BrowserActionPolicyError);
  });

  it("truncates text by utf-8 byte length without splitting characters", () => {
    const result = truncateTextToUtf8Bytes("abc你好", 4);

    assert.equal(result.text, "abc");
    assert.equal(result.truncated, true);
    assert.equal(result.originalBytes, 9);
    assert.equal(result.returnedBytes, 3);
  });
});
