import assert from "node:assert/strict";
import test from "node:test";
import { streamText } from "ai";
import { resolveLLMCall } from "./providers.ts";

for (const modelName of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
  for (const purpose of ["chat", "sampling"] as const) {
    test(`${modelName} ${purpose} requests visible summaries and streams reasoning separately`, async () => {
      const originalFetch = globalThis.fetch;
      let requests = 0;
      try {
        globalThis.fetch = async (_url, init) => {
          const body: unknown = JSON.parse(String(init?.body));
          assert.ok(typeof body === "object" && body !== null);
          assert.ok("thinking" in body && "output_config" in body);
          assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
          assert.deepEqual(body.output_config, { effort: "medium" });
          requests += 1;
          const events = [
            {
              type: "message_start",
              message: {
                id: "msg_thinking_fixture",
                type: "message",
                role: "assistant",
                model: modelName,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "检查当前任务。" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "signature_delta", signature: "fixture-signature" },
            },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "完成。" },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ];
          return new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        };
        const call = resolveLLMCall("anthropic", modelName, "fixture-key", purpose);
        const result = streamText({
          model: call.model,
          ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
          prompt: "检查任务",
        });
        let reasoning = "";
        for await (const part of result.fullStream) {
          if (part.type === "error") throw part.error;
          if (part.type === "reasoning-delta") reasoning += part.text;
        }
        assert.equal(requests, 1);
        assert.equal(reasoning, "检查当前任务。");
        assert.equal(await result.text, "完成。");
        const message = (await result.response).messages[0];
        assert.ok(message?.role === "assistant" && Array.isArray(message.content));
        const block = message.content.find((part) => part.type === "reasoning");
        assert.equal(block?.providerOptions?.anthropic?.signature, "fixture-signature");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}
