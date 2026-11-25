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

test("Google Gemini 4 separates Neon/Hydrogen and Carbon/Argon tiers using terminal model IDs", () => {
  const catalog: ChatGptModelCatalog = { status: "ready", models: [] };
  const viaDefault = {
    llm: { defaultProvider: "google", defaultModel: "gemini-4-neon" },
    runtime: { thinkingLevel: "xhigh", compaction: { thinkingLevel: "xhigh" } },
  };
  const projected = thinkingCatalogForDraft(node, viaDefault, catalog);
  assert.equal(projected.kind, "enum");
  if (projected.kind !== "enum") throw new Error("expected enum");
  assert.equal(projected.optionsStatus, "ready");
  assert.deepEqual(projected.options, ["low", "medium", "high", "xhigh"]);
  assert.ok(
    thinkingFieldValidity(viaDefault, catalog).every(({ message }) => message === undefined),
  );

  const rejectedOff = {
    llm: { defaultProvider: "google", defaultModel: "gemini-4-hydrogen" },
    runtime: { thinkingLevel: "off", compaction: { thinkingLevel: "max" } },
  };
  const issues = thinkingFieldValidity(rejectedOff, catalog);
  assert.match(issues[0]?.message ?? "", /不支持 off/);
  assert.match(issues[1]?.message ?? "", /不支持 max/);

  for (const model of [
    "gemini-4-carbon",
    "gemini-4-argon",
    "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-4-carbon",
  ]) {
    const carbonDraft = {
      llm: { defaultProvider: "google", defaultModel: model },
      runtime: { thinkingLevel: "off", compaction: { thinkingLevel: "xhigh" } },
    };
    const carbonProjected = thinkingCatalogForDraft(node, carbonDraft, catalog);
    assert.equal(carbonProjected.kind, "enum");
    if (carbonProjected.kind !== "enum") throw new Error("expected enum");
    assert.deepEqual(carbonProjected.options, ["low", "medium", "high"]);
    const carbonIssues = thinkingFieldValidity(carbonDraft, catalog);
    assert.match(carbonIssues[0]?.message ?? "", /不支持 off/);
    assert.match(carbonIssues[1]?.message ?? "", /不支持 xhigh/);
  }

  const neonProjectLegacy = {
    llm: {
      defaultProvider: "google",
      defaultModel:
        "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-2.5-flash",
    },
    runtime: { thinkingLevel: "xhigh", compaction: { thinkingLevel: "off" } },
  };
  const legacyProjected = thinkingCatalogForDraft(node, neonProjectLegacy, catalog);
  assert.equal(legacyProjected.kind, "enum");
  if (legacyProjected.kind !== "enum") throw new Error("expected enum");
  assert.deepEqual(legacyProjected.options, ["off", "low", "medium", "high"]);
  const legacyIssues = thinkingFieldValidity(neonProjectLegacy, catalog);
  assert.match(legacyIssues[0]?.message ?? "", /不支持 xhigh/);
  assert.equal(legacyIssues[1]?.message, undefined);

  const carbonProjectNeon = {
    llm: {
      defaultProvider: "google",
      defaultModel:
        "projects/gemini-4-carbon-prod/locations/global/publishers/google/models/gemini-4-neon",
    },
    runtime: { thinkingLevel: "xhigh" },
  };
  const neonProjected = thinkingCatalogForDraft(node, carbonProjectNeon, catalog);
  assert.equal(neonProjected.kind, "enum");
  if (neonProjected.kind !== "enum") throw new Error("expected enum");
  assert.deepEqual(neonProjected.options, ["low", "medium", "high", "xhigh"]);
  assert.ok(
    thinkingFieldValidity(carbonProjectNeon, catalog).every(({ message }) => message === undefined),
  );

  const envModel = {
    llm: { defaultProvider: "google", defaultModel: `\${ROLL_GEMINI_MODEL}` },
    runtime: { thinkingLevel: "xhigh" },
  };
  const envProjected = thinkingCatalogForDraft(node, envModel, catalog);
  assert.equal(envProjected.kind, "enum");
  if (envProjected.kind !== "enum") throw new Error("expected enum");
  assert.equal(envProjected.optionsStatus, "unavailable");
  assert.ok(thinkingFieldValidity(envModel, catalog).every(({ message }) => message === undefined));

  // Model-independent providers (e.g. OpenAI) and known terminal Google segments still validate strictly.
  const openaiEnvModel = {
    llm: { defaultProvider: "openai", defaultModel: `\${ROLL_OPENAI_MODEL}` },
    runtime: { thinkingLevel: "xhigh" },
  };
  const openaiProjected = thinkingCatalogForDraft(node, openaiEnvModel, catalog);
  assert.equal(openaiProjected.kind, "enum");
  if (openaiProjected.kind !== "enum") throw new Error("expected enum");
  assert.equal(openaiProjected.optionsStatus, "ready");
  assert.deepEqual(openaiProjected.options, ["off", "low", "medium", "high"]);
  assert.match(thinkingFieldValidity(openaiEnvModel, catalog)[0]?.message ?? "", /不支持 xhigh/);

  const envProjectCarbon = {
    llm: {
      defaultProvider: "google",
      defaultModel: `projects/\${ROLL_GCP_PROJECT}/locations/global/publishers/google/models/gemini-4-carbon`,
    },
    runtime: { thinkingLevel: "xhigh" },
  };
  const envProjectProjected = thinkingCatalogForDraft(node, envProjectCarbon, catalog);
  assert.equal(envProjectProjected.kind, "enum");
  if (envProjectProjected.kind !== "enum") throw new Error("expected enum");
  assert.equal(envProjectProjected.optionsStatus, "ready");
  assert.deepEqual(envProjectProjected.options, ["low", "medium", "high"]);
  assert.match(thinkingFieldValidity(envProjectCarbon, catalog)[0]?.message ?? "", /不支持 xhigh/);
});
