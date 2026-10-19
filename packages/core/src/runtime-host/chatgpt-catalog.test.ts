import assert from "node:assert/strict";
import { test } from "node:test";
import * as runtime from "@roll-agent/runtime";
import { createChatGptCatalog } from "./chatgpt-catalog.ts";

test("account-local context limits refresh with model choices without polluting API cache", () => {
  const api = new runtime.ModelCatalog({
    snapshot: {
      fetchedAt: new Date().toISOString(),
      providers: { openai: { "api-model": { context: 123456 } } },
    },
  });
  let choices = [{ slug: "subscription-slug", displayName: "Friendly", contextWindow: 272000 }];
  const catalog = createChatGptCatalog(runtime, api, () => choices);
  assert.equal(catalog.lookup("chatgpt", "subscription-slug"), 272000);
  assert.equal(catalog.lookup("openai", "api-model"), 123456);
  assert.equal(api.lookup("chatgpt", "subscription-slug"), undefined);
  assert.equal(catalog.data().providers.chatgpt, undefined);
  choices = [{ slug: "different-account-model", displayName: "Other", contextWindow: 64000 }];
  assert.equal(catalog.lookup("chatgpt", "subscription-slug"), undefined);
  assert.equal(catalog.lookup("chatgpt", "different-account-model"), 64000);
});
