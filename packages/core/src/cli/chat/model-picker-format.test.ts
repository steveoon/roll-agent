import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelPickerItems, DEFAULT_CHOICE_ITEMS } from "./model-picker-format.ts";

test("buildModelPickerItems marks the current model and describes origin", () => {
  const items = buildModelPickerItems(
    [
      { id: "qwen/qwen3.8-max", provider: "qwen", model: "qwen3.8-max", origin: "default" },
      { id: "qwen/qwen3.6-plus", provider: "qwen", model: "qwen3.6-plus", origin: "configured" },
      {
        id: "google/gemini-3.8-flash",
        provider: "google",
        model: "gemini-3.8-flash",
        origin: "builtin",
      },
    ],
    "qwen3.6-plus",
  );
  assert.deepEqual(items, [
    { id: "qwen/qwen3.8-max", title: "qwen/qwen3.8-max", meta: "配置默认" },
    { id: "qwen/qwen3.6-plus", title: "qwen/qwen3.6-plus", meta: "已配置 · 当前" },
    { id: "google/gemini-3.8-flash", title: "google/gemini-3.8-flash", meta: "内置默认" },
  ]);
});

test("DEFAULT_CHOICE_ITEMS offers keep vs set-as-default", () => {
  assert.deepEqual(
    DEFAULT_CHOICE_ITEMS.map((item) => item.id),
    ["keep", "set-default"],
  );
});
