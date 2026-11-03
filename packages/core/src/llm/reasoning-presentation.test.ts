import assert from "node:assert/strict";
import test from "node:test";
import { resolveReasoningPresentation } from "./reasoning-presentation.ts";

const openaiModel = { provider: "openai.responses", modelId: "gpt-5" };
const deepseekModel = { provider: "deepseek.chat", modelId: "deepseek-flash" };
const grokModel = { provider: "xai.responses", modelId: "grok-4.5" };

test("each provider reads only its native display field", () => {
  const summary = { type: "response.reasoning_summary_text.delta", delta: "public" };
  const reasoning = { choices: [{ delta: { reasoning_content: "provider text" } }] };
  const openai = resolveReasoningPresentation(openaiModel, {
    openai: { reasoningEffort: "medium" },
  });
  const deepseek = resolveReasoningPresentation(deepseekModel, {
    deepseek: { thinking: { type: "enabled" } },
  });
  assert.ok(openai && deepseek);
  assert.deepEqual(openai.readDeltas(summary), ["public"]);
  assert.deepEqual(deepseek.readDeltas(reasoning), ["provider text"]);
  assert.deepEqual(openai.readDeltas({ ...summary, type: "response.reasoning_text.delta" }), []);
  assert.deepEqual(openai.readDeltas(reasoning), []);
  assert.equal(resolveReasoningPresentation(grokModel, undefined), undefined);
  assert.deepEqual(deepseek.readDeltas({ choices: [{ delta: { content: "answer" } }] }), []);
});

test("OpenAI observes explicit summary overrides and the Responses model family boundary", () => {
  const custom = { ...openaiModel, modelId: "o3custom" };
  const request = { openai: { reasoningSummary: "auto" } };
  assert.equal(resolveReasoningPresentation(custom, request), undefined);
  assert.equal(
    resolveReasoningPresentation(custom, {
      openai: { forceReasoning: true, reasoningSummary: "auto" },
    })?.kind,
    "summary",
  );
  assert.equal(
    resolveReasoningPresentation(openaiModel, {
      openai: { reasoningEffort: "high", reasoningSummary: null },
    }),
    undefined,
  );
  assert.equal(
    resolveReasoningPresentation(openaiModel, {
      openai: { reasoningEffort: "high", forceReasoning: false },
    }),
    undefined,
  );
});

test("Claude requires an explicit summarized-thinking request and only accepts thinking text deltas", () => {
  const adapter = { provider: "anthropic.messages", modelId: "claude-sonnet-4-6" };
  const display = resolveReasoningPresentation(adapter, {
    anthropic: { thinking: { type: "adaptive", display: "summarized" } },
  });
  assert.ok(display);
  const event = {
    type: "content_block_delta",
    delta: { type: "thinking_delta", thinking: "summary" },
  };
  assert.deepEqual(display.readDeltas(event), ["summary"]);
  for (const raw of [
    { ...event, delta: { type: "signature_delta", signature: "opaque" } },
    { ...event, delta: { type: "text_delta", text: "answer" } },
    { type: "content_block_start", content_block: { type: "redacted_thinking", data: "opaque" } },
    { ...event, delta: { type: "thinking_delta", thinking: "" } },
  ]) {
    assert.deepEqual(display.readDeltas(raw), []);
  }
  assert.equal(resolveReasoningPresentation(adapter, undefined), undefined);
  for (const thinking of [
    { type: "enabled" },
    { type: "adaptive", display: "omitted" },
    { type: "disabled", display: "summarized" },
  ]) {
    assert.equal(resolveReasoningPresentation(adapter, { anthropic: { thinking } }), undefined);
  }
});

test("Qwen only classifies the first choice's private thinking text when enabled", () => {
  const adapter = { provider: "alibaba.chat", modelId: "qwen3.6-plus" };
  const display = resolveReasoningPresentation(adapter, { alibaba: { enableThinking: true } });
  assert.ok(display);
  const raw = { choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }] };
  assert.deepEqual(display.readDeltas(raw), ["thinking"]);
  assert.deepEqual(
    display.readDeltas({ choices: [{ delta: { content: "answer" } }, ...raw.choices] }),
    [],
  );
  assert.equal(
    resolveReasoningPresentation(adapter, { alibaba: { enableThinking: false } }),
    undefined,
  );
  assert.equal(resolveReasoningPresentation(adapter, undefined), undefined);
});

test("Grok's reasoning_text exception is bound to the exact model, adapter and display setting", () => {
  const model = { ...grokModel, modelId: "grok-4.7" };
  const enabled = { xai: { reasoningEffort: "medium" } };
  const display = resolveReasoningPresentation(model, enabled);
  const raw = { type: "response.reasoning_text.delta", delta: "summary" };
  assert.ok(display);
  assert.deepEqual(display.readDeltas(raw), ["summary"]);
  for (const id of ["grok-4.5", "grok-4.6", "grok-4.7-custom"]) {
    const other = { ...model, modelId: id };
    assert.equal(resolveReasoningPresentation(other, enabled), undefined);
  }
  assert.deepEqual(display.readDeltas({ ...raw, type: "response.reasoning_text.done" }), []);
  assert.equal(
    resolveReasoningPresentation(model, { xai: { reasoningEffort: "none" } }),
    undefined,
  );
});
