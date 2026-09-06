import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availableRecordKeyOptions, formatRecordKeyOption } from "./record-key-options.ts";

const OPTIONS = [
  { value: "anthropic", label: "Anthropic Claude", hint: "默认模型 claude-sonnet-4-6" },
  { value: "google", label: "Google Gemini", hint: "默认模型 gemini-3.8-flash" },
  { value: "xai", label: "xAI Grok" },
] as const;

describe("record key options", () => {
  it("hides keys that already exist and keeps catalog order", () => {
    assert.deepEqual(
      availableRecordKeyOptions(OPTIONS, ["google"]).map((option) => option.value),
      ["anthropic", "xai"],
    );
    assert.deepEqual(availableRecordKeyOptions(OPTIONS, ["xai", "anthropic", "google"]), []);
  });

  it("formats label with optional hint", () => {
    assert.equal(
      formatRecordKeyOption(OPTIONS[1]),
      "google — Google Gemini（默认模型 gemini-3.8-flash）",
    );
    assert.equal(formatRecordKeyOption(OPTIONS[2]), "xai — xAI Grok");
  });
});
