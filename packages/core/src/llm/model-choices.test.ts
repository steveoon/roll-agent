import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rollConfigSchema } from "../config/schema.ts";
import { findLlmModelChoice, listLlmModelChoices } from "./model-choices.ts";

function config(overrides: Record<string, unknown>) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "qwen",
      defaultModel: "qwen3.8-max",
      providers: {
        qwen: { apiKey: "k", models: ["qwen3.8-max", "qwen3.6-plus"] },
        google: { apiKey: "k" },
        xai: { apiKey: "   " },
        custom: { apiKey: "k" },
      },
    },
    ask: {},
    agents: { dataDir: "/tmp/agents" },
    ...overrides,
  });
}

describe("listLlmModelChoices", () => {
  it("puts the effective default first, then configured models, then builtin fallbacks", () => {
    assert.deepEqual(
      listLlmModelChoices(config({})).map((choice) => [choice.id, choice.origin]),
      [
        ["qwen/qwen3.8-max", "default"],
        ["qwen/qwen3.6-plus", "configured"],
        ["google/gemini-3.8-flash", "builtin"],
      ],
    );
  });

  it("honours runtime.provider / runtime.model as the effective default", () => {
    const choices = listLlmModelChoices(
      config({ runtime: { provider: "google", model: "gemini-3.1-pro-preview" } }),
    );
    assert.deepEqual(choices[0], {
      id: "google/gemini-3.1-pro-preview",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      origin: "default",
    });
    assert.ok(
      choices.some((choice) => choice.id === "qwen/qwen3.8-max" && choice.origin === "configured"),
    );
  });
});

describe("findLlmModelChoice", () => {
  const choices = listLlmModelChoices(config({}));

  it("matches provider/model exactly and bare model names when unique", () => {
    assert.equal(findLlmModelChoice(choices, "qwen/qwen3.6-plus")?.id, "qwen/qwen3.6-plus");
    assert.equal(findLlmModelChoice(choices, "gemini-3.8-flash")?.id, "google/gemini-3.8-flash");
    assert.equal(findLlmModelChoice(choices, "  qwen3.8-max ")?.id, "qwen/qwen3.8-max");
  });

  it("returns undefined for unknown or ambiguous input", () => {
    assert.equal(findLlmModelChoice(choices, "nope"), undefined);
    const dup = listLlmModelChoices(
      config({
        llm: {
          defaultProvider: "qwen",
          defaultModel: "shared",
          providers: { qwen: { apiKey: "k" }, google: { apiKey: "k", models: ["shared"] } },
        },
      }),
    );
    assert.equal(findLlmModelChoice(dup, "shared"), undefined);
    assert.equal(findLlmModelChoice(dup, "google/shared")?.provider, "google");
  });
});
