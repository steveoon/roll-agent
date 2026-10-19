import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./loader.ts";
import { writeDefaultLlm } from "./default-llm-writer.ts";

describe("writeDefaultLlm", () => {
  it("rewrites llm.default-provider / default-model and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-default-llm-"));
    const configPath = join(dir, "roll.config.yaml");
    writeFileSync(
      configPath,
      [
        "llm:",
        "  default-provider: qwen",
        "  default-model: qwen3.8-max",
        "  providers:",
        "    qwen:",
        "      api-key: $" + "{DASHSCOPE_API_KEY}",
        "    google:",
        "      api-key: $" + "{GOOGLE_GENERATIVE_AI_API_KEY}",
        "runtime:",
        "  provider: qwen",
        "  model: qwen3.8-max",
        "  thinking-level: low",
        "agents:",
        "  data-dir: ~/.roll-agent/agents",
        "",
      ].join("\n"),
    );
    try {
      const result = writeDefaultLlm(
        { provider: "google", model: "gemini-3.8-flash" },
        { configPath },
      );
      assert.equal(result.configPath, configPath);
      const written = readFileSync(configPath, "utf8");
      assert.match(written, /default-provider: google/u);
      assert.match(written, /default-model: gemini-3\.8-flash/u);
      assert.match(written, /api-key: \$\{DASHSCOPE_API_KEY\}/u);
      assert.doesNotMatch(written, /qwen3\.8-max/u);
      assert.match(written, /thinking-level: low/u);
      const config = loadConfig({ cwd: dir }).config;
      assert.equal(config.runtime.provider, undefined);
      assert.equal(config.runtime.model, undefined);
      assert.equal(config.runtime.thinkingLevel, "low");
      assert.equal(config.llm.defaultProvider, "google");
      assert.equal(config.llm.defaultModel, "gemini-3.8-flash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("subscription default stays in runtime without replacing API-key defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-chatgpt-default-"));
  const configPath = join(dir, "roll.config.yaml");
  writeFileSync(
    configPath,
    "llm:\n  default-provider: openai\n  default-model: gpt-api\n  providers:\n    openai:\n      api-key: retained-key\n",
  );
  try {
    writeDefaultLlm(
      {
        provider: "chatgpt",
        model: "subscription-slug",
        chatgptAccountId: "registration-one",
        thinkingLevel: "max",
      },
      { configPath },
    );
    const config = loadConfig({ cwd: dir }).config;
    assert.equal(config.runtime.provider, "chatgpt");
    assert.equal(config.runtime.thinkingLevel, "max");
    assert.equal(config.runtime.model, "subscription-slug");
    assert.equal(config.runtime.chatgptAccountId, "registration-one");
    assert.equal(config.llm.defaultProvider, "openai");
    assert.equal(config.llm.defaultModel, "gpt-api");
    assert.equal(config.llm.providers.openai?.apiKey, "retained-key");
    const written = readFileSync(configPath, "utf8");
    assert.match(written, /chatgpt-account-id: registration-one/u);
    assert.doesNotMatch(written, /providers:\s+chatgpt/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
