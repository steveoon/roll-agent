import assert from "node:assert/strict";
import { test } from "node:test";
import { reloadNativePageAndWaitForSwap } from "./native-reload.ts";
import type { NativeReloadController } from "./native-reload.ts";

type SwapState = { readonly mark: string | null; readonly readyState: string };

function createController(options: {
  readonly states: SwapState[];
  readonly calls: string[];
  readonly reloadError?: Error;
}): NativeReloadController {
  let stateIndex = 0;
  return {
    async evaluateJson<T>(expression: string): Promise<T> {
      if (expression.includes("window.__rollReloadMark =")) {
        options.calls.push("mark");
        return true as T;
      }
      options.calls.push("poll");
      const state = options.states[Math.min(stateIndex, options.states.length - 1)];
      stateIndex += 1;
      return state as T;
    },
    async reload(): Promise<void> {
      options.calls.push("reload");
      if (options.reloadError) {
        throw options.reloadError;
      }
    },
  };
}

const fixedToken = "token-fixed";
const noopDelay = async (): Promise<void> => {};

test("does not return while the stale document still carries the sentinel", async () => {
  const calls: string[] = [];
  const controller = createController({
    calls,
    states: [
      { mark: fixedToken, readyState: "complete" },
      { mark: fixedToken, readyState: "complete" },
      { mark: null, readyState: "complete" },
    ],
  });

  await reloadNativePageAndWaitForSwap(controller, {
    url: "https://www.zhipin.com/web/chat/index",
    createToken: () => fixedToken,
    delay: noopDelay,
    pollMs: 1,
  });

  assert.deepEqual(calls, ["mark", "reload", "poll", "poll", "poll"]);
});

test("returns once the document is swapped and interactive", async () => {
  const calls: string[] = [];
  const controller = createController({
    calls,
    states: [
      { mark: null, readyState: "loading" },
      { mark: null, readyState: "interactive" },
    ],
  });

  await reloadNativePageAndWaitForSwap(controller, {
    url: "https://www.zhipin.com/web/chat/index",
    createToken: () => fixedToken,
    delay: noopDelay,
    pollMs: 1,
  });

  assert.deepEqual(calls, ["mark", "reload", "poll", "poll"]);
});

test("throws when the document never swaps within timeout", async () => {
  const calls: string[] = [];
  let clock = 0;
  const controller = createController({
    calls,
    states: [{ mark: fixedToken, readyState: "complete" }],
  });

  await assert.rejects(
    reloadNativePageAndWaitForSwap(controller, {
      url: "https://www.zhipin.com/web/chat/index",
      createToken: () => fixedToken,
      delay: noopDelay,
      pollMs: 10,
      timeoutMs: 30,
      now: () => {
        const value = clock;
        clock += 10;
        return value;
      },
    }),
    /did not swap document within 30ms/,
  );
});

test("forwards ignoreCache and url to the reload primitive", async () => {
  const calls: string[] = [];
  let reloadArgs: unknown;
  const controller: NativeReloadController = {
    async evaluateJson<T>(expression: string): Promise<T> {
      if (expression.includes("window.__rollReloadMark =")) {
        return true as T;
      }
      return { mark: null, readyState: "complete" } as T;
    },
    async reload(args): Promise<void> {
      calls.push("reload");
      reloadArgs = args;
    },
  };

  await reloadNativePageAndWaitForSwap(controller, {
    createToken: () => fixedToken,
    delay: noopDelay,
    pollMs: 1,
    url: "https://www.zhipin.com/web/chat/index",
    ignoreCache: true,
  });

  assert.deepEqual(reloadArgs, {
    url: "https://www.zhipin.com/web/chat/index",
    ignoreCache: true,
  });
});

test("calls onReloadSent after Page.reload is accepted", async () => {
  const calls: string[] = [];
  const controller = createController({
    calls,
    states: [{ mark: null, readyState: "complete" }],
  });

  await reloadNativePageAndWaitForSwap(controller, {
    url: "https://www.zhipin.com/web/chat/index",
    createToken: () => fixedToken,
    delay: noopDelay,
    pollMs: 1,
    onReloadSent: () => {
      calls.push("sent");
    },
  });

  assert.deepEqual(calls, ["mark", "reload", "sent", "poll"]);
});
