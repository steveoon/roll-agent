import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import {
  ZHIPIN_ACCESS_RESTRICTED_CODE,
  createZhipinAccessRestrictedError,
} from "../pages/zhipin/risk-page.ts";
import { setZhipinOpenResumeDepsForTests, zhipinOpenResume } from "./zhipin-open-resume.ts";

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

afterEach(() => {
  setZhipinOpenResumeDepsForTests(undefined);
});

describe("zhipin_open_resume", () => {
  it("accepts candidateRef input", () => {
    const parsed = zhipinOpenResume.input.parse({ candidateRef: "@c1" });

    assert.equal(parsed.candidateRef, "@c1");
  });

  it("rejects invalid candidateRef input before execution", () => {
    assert.throws(
      () => zhipinOpenResume.input.parse({ candidateRef: "candidate-1" }),
      /candidateRef 应类似 @c1/,
    );
  });

  it("rethrows zhipin_access_restricted from openNativePagePort instead of asking to retry", async () => {
    setZhipinOpenResumeDepsForTests({
      openNativePagePort: async () => {
        throw createZhipinAccessRestrictedError({
          kind: "ip_block",
          url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
          title: "访问受限",
        });
      },
    });

    await assert.rejects(
      () => zhipinOpenResume.execute({ index: 0 }, createTestContext()),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        assert.doesNotMatch(error.message, /请重试/u);
        return true;
      },
    );
  });
});
