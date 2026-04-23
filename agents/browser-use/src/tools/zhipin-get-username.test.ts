import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import { setVisualActivityEnabledForTests } from "../visual-activity.ts";
import {
  setZhipinGetUsernameDepsForTests,
  zhipinGetUsername,
} from "./zhipin-get-username.ts";

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

function createPage() {
  return {
    bringToFront: async () => {},
  };
}

afterEach(() => {
  setVisualActivityEnabledForTests(undefined);
  setZhipinGetUsernameDepsForTests(undefined);
});

describe("zhipin_get_username", () => {
  it("reads the username successfully without calling getPage twice", async () => {
    setVisualActivityEnabledForTests(false);
    const page = createPage();
    let getPageCalls = 0;

    setZhipinGetUsernameDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            getPageCalls += 1;
            return page;
          },
        }) as never,
      findHeaderScope: async () => null,
      getCurrentZhipinRecruiterIdentity: async () => ({
        platform: "zhipin",
        username: "任思文",
        strategy: "css-fallback",
        source: ".user-name",
      }),
    });

    const result = await zhipinGetUsername.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.username, "任思文");
    assert.equal(result.usedSelector, ".user-name");
    assert.equal(getPageCalls, 1);
  });

  it("returns a failure result without calling getPage again in the catch path", async () => {
    setVisualActivityEnabledForTests(false);
    const page = createPage();
    let getPageCalls = 0;

    setZhipinGetUsernameDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            getPageCalls += 1;
            return page;
          },
        }) as never,
      findHeaderScope: async () => null,
      getCurrentZhipinRecruiterIdentity: async () => {
        throw new Error("未找到用户名");
      },
    });

    const result = await zhipinGetUsername.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.username, "");
    assert.match(result.error ?? "", /未找到用户名/);
    assert.equal(getPageCalls, 1);
  });
});
