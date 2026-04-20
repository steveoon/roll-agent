import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BrowserContextManager, BrowserRuntime, SessionStore } from "@roll-agent/browser";
import {
  getContextManager,
  getReplyAuthorityKeysLoaded,
  getRuntime,
  getSessionStore,
  setReplyAuthorityKeysLoaded,
  setRuntimeStateForTests,
  shutdownRuntime,
} from "./runtime-holder.ts";

const ORIGINAL_CONSOLE_ERROR = console.error;

afterEach(() => {
  console.error = ORIGINAL_CONSOLE_ERROR;
  setRuntimeStateForTests({});
  setReplyAuthorityKeysLoaded(false);
});

describe("runtime-holder", () => {
  it("logs shutdown messages through the agent logger format", async () => {
    const errorLogs: string[] = [];
    console.error = (message?: unknown, ...optionalParams: unknown[]) => {
      errorLogs.push([message, ...optionalParams].map((item) => String(item)).join(" "));
    };

    await shutdownRuntime();

    assert.match(
      errorLogs[0] ?? "",
      /\[INFO \] \[browser-use-agent\] Browser runtime shutdown complete/,
    );
  });

  it("resets runtime state even when cleanup fails", async () => {
    const errorLogs: string[] = [];
    console.error = (message?: unknown, ...optionalParams: unknown[]) => {
      errorLogs.push([message, ...optionalParams].map((item) => String(item)).join(" "));
    };

    setRuntimeStateForTests({
      contextManager: {
        closeAll: async () => {
          throw new Error("close contexts failed");
        },
      } as unknown as BrowserContextManager,
      runtime: {
        stop: async () => {
          throw new Error("stop runtime failed");
        },
      } as unknown as BrowserRuntime,
      sessionStore: {} as SessionStore,
    });
    setReplyAuthorityKeysLoaded(true);

    await assert.rejects(async () => await shutdownRuntime(), (error: unknown) => {
      if (!(error instanceof AggregateError)) {
        return false;
      }

      assert.equal(error.errors.length, 2);
      assert.equal((error.errors[0] as Error).message, "Failed to close browser contexts");
      assert.equal((error.errors[1] as Error).message, "Failed to stop browser runtime");
      return true;
    });

    assert.equal(getReplyAuthorityKeysLoaded(), false);
    assert.throws(() => getContextManager(), /BrowserContextManager not initialized/);
    assert.throws(() => getRuntime(), /BrowserRuntime not initialized/);
    assert.throws(() => getSessionStore(), /SessionStore not initialized/);
    assert.match(errorLogs.join("\n"), /Failed to close browser contexts/);
    assert.match(errorLogs.join("\n"), /Failed to stop browser runtime/);
  });
});
