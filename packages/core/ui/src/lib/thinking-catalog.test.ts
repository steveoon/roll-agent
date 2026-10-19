import assert from "node:assert/strict";
import { test } from "node:test";
import {
  thinkingCatalog,
  thinkingCatalogForDraft,
  thinkingFieldValidity,
  type ChatGptModelCatalog,
} from "./thinking-catalog.ts";
import type { ConfigEnumCatalogNode } from "../types.ts";

const node: ConfigEnumCatalogNode = {
  kind: "enum",
  path: ["runtime", "thinkingLevel"],
  title: "推理强度",
  options: ["off", "low", "medium", "high", "xhigh", "max"],
  effectiveRequired: true,
  persistedRequired: false,
  defaultValue: "medium",
  widget: "select",
  secret: false,
  readOnly: false,
};
test("subscription enum options follow model capability without changing authoritative catalog", () => {
  const result = thinkingCatalog(node, "chatgpt", {
    reasoningEfforts: ["low", "high", "xhigh", "max"],
  });
  assert.equal(result.kind, "enum");
  if (result.kind !== "enum") throw new Error("expected enum");
  assert.deepEqual(result.options, ["low", "high", "xhigh", "max"]);
  assert.deepEqual(node.options, ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(result.defaultValue, "medium");
});
test("loading, model changes and account ownership refresh hidden field validation without rewriting values", () => {
  const draft = {
    runtime: {
      provider: "chatgpt",
      model: "fixture",
      chatgptAccountId: "a",
      thinkingLevel: "max",
      compaction: { thinkingLevel: "max" },
    },
  };
  const ready: ChatGptModelCatalog = {
    accountId: "a",
    status: "ready",
    models: [{ slug: "fixture", displayName: "fixture", reasoningEfforts: ["low", "max"] }],
  };
  assert.ok(thinkingFieldValidity(draft, ready).every(({ message }) => message === undefined));
  const loading: ChatGptModelCatalog = { accountId: "a", status: "loading", models: [] };
  assert.ok(thinkingFieldValidity(draft, loading).every(({ message }) => message === undefined));
  const filtered = thinkingCatalogForDraft(node, draft, loading);
  assert.equal(filtered.kind, "enum");
  if (filtered.kind === "enum") assert.equal(filtered.optionsStatus, "loading");
  const unsupported: ChatGptModelCatalog = {
    ...ready,
    models: [{ slug: "fixture", displayName: "fixture", reasoningEfforts: ["low"] }],
  };
  assert.ok(
    thinkingFieldValidity(draft, unsupported).every(({ message }) =>
      message?.includes("不支持 max"),
    ),
  );
  assert.ok(thinkingFieldValidity(draft, ready).every(({ message }) => message === undefined));
  assert.ok(
    thinkingFieldValidity(draft, { ...unsupported, accountId: "b" }).every(
      ({ message }) => message === undefined,
    ),
  );
  assert.equal(draft.runtime.thinkingLevel, "max");
  assert.equal(draft.runtime.compaction.thinkingLevel, "max");
});

test("API keeps four levels while missing subscription capability stays pending", () => {
  const api = thinkingCatalog(node, "openai");
  assert.equal(api.kind, "enum");
  if (api.kind === "enum") assert.deepEqual(api.options, ["off", "low", "medium", "high"]);
  const pending = thinkingCatalog(node, "chatgpt");
  assert.equal(pending.kind, "enum");
  if (pending.kind === "enum") {
    assert.equal(pending.optionsStatus, "unavailable");
    assert.ok(pending.options.includes("max"));
  }
  const result = thinkingCatalog(
    { ...node, path: ["runtime", "compaction", "thinkingLevel"] },
    "chatgpt",
    { reasoningEfforts: ["none", "max"] },
  );
  if (result.kind !== "enum") throw new Error("expected enum");
  assert.deepEqual(result.options, ["off", "max"]);
});

test("unresolved provider, model and account references cannot block valid reasoning levels", () => {
  const catalog: ChatGptModelCatalog = {
    accountId: "a",
    status: "ready",
    models: [
      { slug: "fixture", displayName: "fixture", reasoningEfforts: ["low", "max", "xhigh"] },
    ],
  };
  for (const field of ["provider", "model", "chatgptAccountId"] as const) {
    const draft = {
      runtime: {
        provider: "chatgpt",
        model: "fixture",
        chatgptAccountId: "a",
        thinkingLevel: "max",
        compaction: { thinkingLevel: "xhigh" },
        [field]: `\${ROLL_TEST_VALUE}`,
      },
    };
    assert.ok(thinkingFieldValidity(draft, catalog).every(({ message }) => message === undefined));
    const projected = thinkingCatalogForDraft(node, draft, catalog);
    assert.equal(projected.kind, "enum");
    if (projected.kind === "enum") {
      assert.equal(projected.optionsStatus, "unavailable");
      assert.ok(projected.options.includes("max"));
    }
    assert.equal(draft.runtime[field], `\${ROLL_TEST_VALUE}`);
  }
});

test("missing models and effort metadata stay unknown, while llm provider fallback is honored", () => {
  const draft = {
    llm: { defaultProvider: "chatgpt" },
    runtime: { model: "fixture", thinkingLevel: "max" },
  };
  for (const models of [[], [{ slug: "fixture", displayName: "fixture" }]]) {
    const catalog: ChatGptModelCatalog = { status: "ready", models };
    assert.ok(thinkingFieldValidity(draft, catalog).every(({ message }) => message === undefined));
    const projected = thinkingCatalogForDraft(node, draft, catalog);
    if (projected.kind !== "enum") throw new Error("expected enum");
    assert.equal(projected.optionsStatus, "unavailable");
  }
  const catalog: ChatGptModelCatalog = {
    status: "ready",
    models: [{ slug: "fixture", displayName: "fixture", reasoningEfforts: ["low", "max"] }],
  };
  assert.ok(thinkingFieldValidity(draft, catalog).every(({ message }) => message === undefined));
  assert.match(
    thinkingFieldValidity({ ...draft, llm: { defaultProvider: "openai" } }, catalog)[0]?.message ??
      "",
    /不支持 max/,
  );
});
