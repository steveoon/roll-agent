import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import { sendFeishuWebhook } from "../src/services/feishu.ts";
import { sendFeishuMessage } from "../src/tools/send-feishu-message.ts";

const originalFetch = globalThis.fetch;
const originalWebhook = process.env["FEISHU_BOT_WEBHOOK"];

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalWebhook === undefined) {
    delete process.env["FEISHU_BOT_WEBHOOK"];
  } else {
    process.env["FEISHU_BOT_WEBHOOK"] = originalWebhook;
  }
});

test("sendFeishuWebhook returns structured success result", async () => {
  const result = await sendFeishuWebhook("https://example.com/webhook", "hello", {
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 0, msg: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  assert.deepEqual(result, {
    success: true,
    responseCode: 0,
    responseMessage: "ok",
  });
});

test("sendFeishuWebhook surfaces provider errors", async () => {
  const result = await sendFeishuWebhook("https://example.com/webhook", "hello", {
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 19024, msg: "keyword not matched" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  assert.equal(result.success, false);
  assert.equal(result.errorType, "provider");
  assert.equal(result.responseCode, 19024);
  assert.equal(result.responseMessage, "keyword not matched");
  assert.match(result.error, /keyword not matched/);
});

test("sendFeishuWebhook rejects invalid JSON responses", async () => {
  const result = await sendFeishuWebhook("https://example.com/webhook", "hello", {
    fetchImpl: async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  });

  assert.equal(result.success, false);
  assert.equal(result.errorType, "invalid-response");
  assert.match(result.error, /non-JSON response/);
});

test("sendFeishuWebhook handles request timeout", async () => {
  const result = await sendFeishuWebhook("https://example.com/webhook", "hello", {
    timeoutMs: 1,
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  });

  assert.equal(result.success, false);
  assert.equal(result.errorType, "timeout");
  assert.match(result.error, /timed out/);
});

test("sendFeishuMessage returns config error when webhook is missing", async () => {
  delete process.env["FEISHU_BOT_WEBHOOK"];

  const result = sendFeishuMessage.output.parse(
    await sendFeishuMessage.execute(
      sendFeishuMessage.input.parse({ text: "hello" }),
      createTestContext(),
    ),
  );

  assert.equal(result.success, false);
  if (result.success || !("errorType" in result) || !("error" in result)) {
    throw new Error("Expected config failure");
  }
  assert.equal(result.errorType, "config");
  assert.match(result.error, /FEISHU_BOT_WEBHOOK/);
});

test("sendFeishuMessage returns structured success output", async () => {
  process.env["FEISHU_BOT_WEBHOOK"] = "https://example.com/webhook";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 0, msg: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const result = sendFeishuMessage.output.parse(
    await sendFeishuMessage.execute(
      sendFeishuMessage.input.parse({ text: "  hello  " }),
      createTestContext(),
    ),
  );

  assert.deepEqual(result, {
    success: true,
    provider: "feishu",
    responseCode: 0,
    responseMessage: "ok",
  });
});

function createTestContext(): AgentContext {
  return {
    llm: {
      generateText: async () => {
        throw new Error("LLM should not be called in notify-agent tests");
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}
