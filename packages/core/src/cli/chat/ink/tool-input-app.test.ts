import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { cleanup, render } from "ink-testing-library";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "@roll-agent/runtime";
import { ChatApp } from "./app.ts";

afterEach(() => cleanup());
async function until(assertion: () => void) {
  let error: unknown;
  for (let i = 0; i < 150; i += 1) {
    try {
      assertion();
      return;
    } catch (reason) {
      error = reason;
      await delay(10);
    }
  }
  throw error;
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("normal Ink shows real SDK parameter generation, then waiting after end, without parameter text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-tool-input-ink-"));
  const begin = gate();
  const end = gate();
  const finish = gate();
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          await begin.promise;
          controller.enqueue({
            type: "tool-input-start",
            id: "call",
            toolName: "roll__write_file",
          });
          for (let i = 0; i < 200; i += 1) {
            controller.enqueue({
              type: "tool-input-delta",
              id: "call",
              delta: "SECRET_PARAMETER_JSON",
            });
          }
          await end.promise;
          controller.enqueue({ type: "tool-input-end", id: "call" });
          await finish.promise;
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
  const session = new AgentSession({
    id: "ink-tool-input",
    model,
    sources: [],
    fileTools: { workdir: dir },
    maxSteps: 1,
  });
  const view = render(
    h(ChatApp, { session, model: "fixture", onUserSubmit: () => {}, onExit: () => {} }),
  );
  const frame = () => stripVTControlCharacters(view.lastFrame() ?? "");
  try {
    await delay(30);
    view.stdin.write("work");
    await delay(20);
    view.stdin.write("\r");
    await until(() => assert.match(frame(), /等待模型响应/));
    begin.release();
    await until(() => assert.match(frame(), /正在生成工具参数 roll\.write_file/));
    assert.doesNotMatch(frame(), /SECRET_PARAMETER_JSON|确认执行|执行 roll\.write_file/);
    assert.equal(session.getToolExecutions().length, 0);
    end.release();
    await until(() => {
      assert.match(frame(), /等待模型响应/);
      assert.doesNotMatch(frame(), /正在生成工具参数/);
    });
    finish.release();
    await until(() => assert.doesNotMatch(frame(), /正在生成工具参数|等待模型响应/));
    assert.equal(session.getToolExecutions().length, 0);
  } finally {
    begin.release();
    end.release();
    finish.release();
    view.unmount();
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
