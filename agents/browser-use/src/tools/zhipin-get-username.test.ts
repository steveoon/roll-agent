import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import { setVisualActivityEnabledForTests } from "../visual-activity.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
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

function createNativePage(
  options: {
    readonly evidence?: ReadonlyArray<{
      readonly text: string;
      readonly strategy: "css-fallback";
      readonly priority: number;
      readonly source: string;
    }>;
    readonly throwOnEvidence?: Error;
    readonly onClose?: () => void;
  } = {},
): ZhipinNativePagePort {
  return {
    async readUsernameEvidence() {
      if (options.throwOnEvidence !== undefined) {
        throw options.throwOnEvidence;
      }
      return (
        options.evidence ?? [
          {
            text: "任思文",
            strategy: "css-fallback",
            priority: 4,
            source: ".user-name",
          },
        ]
      );
    },
    close() {
      options.onClose?.();
    },
  } as unknown as ZhipinNativePagePort;
}

function createNoopNativeSession() {
  return {
    begin: async () => true,
    highlightSelector: async () => true,
    succeed: async () => true,
    fail: async () => true,
  };
}

afterEach(() => {
  setVisualActivityEnabledForTests(undefined);
  setZhipinGetUsernameDepsForTests(undefined);
});

describe("zhipin_get_username", () => {
  it("reads the username successfully through native backend", async () => {
    setVisualActivityEnabledForTests(false);
    let openNativePageCalls = 0;
    let closeCalls = 0;

    setZhipinGetUsernameDepsForTests({
      openNativePagePort: async () => {
        openNativePageCalls += 1;
        return createNativePage({
          onClose: () => {
            closeCalls += 1;
          },
        });
      },
      createNativeVisualActivitySession: () => createNoopNativeSession() as never,
    });

    const result = await zhipinGetUsername.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.username, "任思文");
    assert.equal(result.usedSelector, ".user-name");
    assert.equal(openNativePageCalls, 1);
    assert.equal(closeCalls, 1);
  });

  it("returns a failure result without falling back to Playwright", async () => {
    setVisualActivityEnabledForTests(false);
    let openNativePageCalls = 0;
    let closeCalls = 0;

    setZhipinGetUsernameDepsForTests({
      openNativePagePort: async () => {
        openNativePageCalls += 1;
        return createNativePage({
          evidence: [],
          onClose: () => {
            closeCalls += 1;
          },
        });
      },
      createNativeVisualActivitySession: () => createNoopNativeSession() as never,
    });

    const result = await zhipinGetUsername.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.username, "");
    assert.match(result.error ?? "", /未找到用户名/);
    assert.equal(openNativePageCalls, 1);
    assert.equal(closeCalls, 1);
  });
});
