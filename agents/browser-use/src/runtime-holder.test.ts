import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { shutdownRuntime } from "./runtime-holder.ts";

const ORIGINAL_CONSOLE_ERROR = console.error;

afterEach(() => {
  console.error = ORIGINAL_CONSOLE_ERROR;
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
});
