import assert from "node:assert/strict";
import { it } from "node:test";
import { selectChatGptAccount, selectChatGptModel } from "./chatgpt-selection.ts";

it("account selection retains the API-key provider and model until a subscription model is chosen", () => {
  const selected = selectChatGptAccount(
    { runtime: { provider: "openai", model: "gpt-api" } },
    "new-account",
  );
  assert.deepEqual(selected.runtime, {
    provider: "openai",
    model: "gpt-api",
    chatgptAccountId: "new-account",
  });
});

it("changing an active subscription account clears only its previous model", () => {
  const selected = selectChatGptAccount(
    { runtime: { provider: "chatgpt", model: "old-model", chatgptAccountId: "old-account" } },
    "new-account",
  );
  assert.deepEqual(selected.runtime, { provider: "chatgpt", chatgptAccountId: "new-account" });
  const retained = selectChatGptAccount(
    { runtime: { provider: "chatgpt", model: "valid-model", chatgptAccountId: "same" } },
    "same",
  );
  assert.equal((retained.runtime as Record<string, unknown>).model, "valid-model");
});

it("pins the catalog account when selecting a model without an explicit account draft", () => {
  const initial = {
    runtime: { provider: "openai", model: "previous", contextWindow: 8192 },
    chat: { screenMode: "fullscreen" },
  };
  const catalogAccount = "25ecece0-b713-4296-8931-a2ea002f3775";
  const selected = selectChatGptModel(initial, "selected-model", catalogAccount);
  assert.deepEqual(selected.runtime, {
    provider: "chatgpt",
    model: "selected-model",
    chatgptAccountId: catalogAccount,
    contextWindow: 8192,
  });
  assert.deepEqual(selected.chat, initial.chat);
  assert.deepEqual(initial.runtime, { provider: "openai", model: "previous", contextWindow: 8192 });
});

it("replaces the prior account and model together without deleting the new model", () => {
  const selected = selectChatGptModel(
    { runtime: { provider: "chatgpt", model: "old-model", chatgptAccountId: "old-account" } },
    "new-model",
    "new-account",
  );
  assert.deepEqual(selected.runtime, {
    provider: "chatgpt",
    model: "new-model",
    chatgptAccountId: "new-account",
  });
});
