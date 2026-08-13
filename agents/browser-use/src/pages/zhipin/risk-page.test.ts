import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StructuredToolError } from "@roll-agent/sdk";
import {
  ZHIPIN_ACCESS_RESTRICTED_CODE,
  assertZhipinPageNotRestricted,
  createZhipinAccessRestrictedError,
  inspectZhipinRiskPage,
  rethrowStructuredToolError,
} from "./risk-page.ts";

describe("inspectZhipinRiskPage", () => {
  it("classifies passport 403 as ip_block, and code=32 as uid_block", () => {
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
      })?.kind,
      "ip_block",
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/common/403.html",
        title: "BOSS直聘",
      })?.kind,
      "ip_block",
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/passport/cm/403.html?code=32",
      })?.kind,
      "uid_block",
    );
  });

  it("classifies verify and security paths", () => {
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/passport/zp/verify.html",
      })?.kind,
      "verify",
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/user/safe/verify-slider?callbackUrl=%2F",
      })?.kind,
      "verify",
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/passport/zp/security.html",
      })?.kind,
      "security",
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/common/security-check.html",
      })?.kind,
      "security",
    );
  });

  it("maps legacy and variant block codes to the right kind", () => {
    const base = "https://www.zhipin.com/web/passport/zp/403.html";
    assert.equal(inspectZhipinRiskPage({ url: `${base}?code=5002` })?.kind, "ip_block");
    assert.equal(inspectZhipinRiskPage({ url: `${base}?code=-1000031` })?.kind, "ip_block");
    assert.equal(inspectZhipinRiskPage({ url: `${base}?code=5003` })?.kind, "uid_block");
    assert.equal(inspectZhipinRiskPage({ url: `${base}?code=5004` })?.kind, "uid_block");
    assert.equal(inspectZhipinRiskPage({ url: `${base}?code=99999` })?.kind, "ip_block");
  });

  it("classifies anti-spider login redirects only when code=38 is present", () => {
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/user/?ka=header-login&code=38",
      })?.kind,
      "anti_spider_login",
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/user/?ka=header-login",
        title: "BOSS直聘-登录",
      }),
      null,
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/user/safe/verify-slider?code=38",
      })?.kind,
      "verify",
    );
  });

  it("falls back to page titles when the URL is not a known risk path", () => {
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/geek/recommend",
        title: "访问受限",
      })?.kind,
      "ip_block",
    );
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/chat/index",
        title: "安全验证",
      })?.kind,
      "verify",
    );
  });

  it("returns null for ordinary BOSS pages", () => {
    assert.equal(
      inspectZhipinRiskPage({
        url: "https://www.zhipin.com/web/chat/index",
        title: "BOSS直聘",
      }),
      null,
    );
  });
});

describe("assertZhipinPageNotRestricted", () => {
  it("throws zhipin_access_restricted and tells the operator not to retry", () => {
    assert.throws(
      () =>
        assertZhipinPageNotRestricted({
          url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
          title: "访问受限",
        }),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        assert.match(error.payload.message, /换 browserInstance\/profile 均无效/u);
        assert.equal(error.payload.details?.["kind"], "ip_block");
        return true;
      },
    );
  });

  it("does not throw on a normal chat page", () => {
    assert.doesNotThrow(() =>
      assertZhipinPageNotRestricted({
        url: "https://www.zhipin.com/web/chat/index",
        title: "BOSS直聘",
      }),
    );
  });
});

describe("rethrowStructuredToolError", () => {
  it("rethrows StructuredToolError including access-restricted", () => {
    const restricted = createZhipinAccessRestrictedError({
      kind: "verify",
      url: "https://www.zhipin.com/web/passport/zp/verify.html",
      title: "安全验证",
    });
    assert.throws(() => rethrowStructuredToolError(restricted), restricted);
    assert.doesNotThrow(() => rethrowStructuredToolError(new Error("network")));
  });
});
