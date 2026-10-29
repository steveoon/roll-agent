import assert from "node:assert/strict";
import { test } from "node:test";
import { assertChatGptFastModeSupported, withChatGptFastMode } from "./chatgpt-fast-mode.ts";

test("Fast preserves independent provider settings and off removes the service tier without mutation", () => {
  const original = {
    openai: { reasoningEffort: "max", include: ["reasoning.encrypted_content"] },
    another: { enabled: true },
  };
  const fast = withChatGptFastMode(original, true);
  assert.equal(fast.openai?.serviceTier, "priority");
  assert.equal(fast.openai?.reasoningEffort, "max");
  assert.deepEqual(withChatGptFastMode(fast, false), original);
  assert.equal(fast.openai?.serviceTier, "priority");
  assert.equal(Object.hasOwn(original.openai, "serviceTier"), false);
  assert.equal(
    Object.hasOwn(withChatGptFastMode(undefined, false).openai ?? {}, "serviceTier"),
    false,
  );
});

test("Fast requires an advertised capability, while disabling needs no catalog", () => {
  assert.doesNotThrow(() => assertChatGptFastModeSupported(false));
  assert.doesNotThrow(() =>
    assertChatGptFastModeSupported(true, { slug: "any-live-slug", supportsFastMode: true }),
  );
  for (const model of [
    undefined,
    { slug: "unknown" },
    { slug: "unsupported", supportsFastMode: false },
  ]) {
    assert.throws(() => assertChatGptFastModeSupported(true, model), /\/fast off/);
  }
});
