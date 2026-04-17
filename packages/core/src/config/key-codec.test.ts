import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  camelToKebab,
  decodeFromYaml,
  encodePathToYaml,
  kebabToCamel,
  normalizeUserPath,
} from "./key-codec.ts";

describe("key-codec: decodeFromYaml", () => {
  it("should convert kebab-case schema fields to camelCase", () => {
    const input = {
      llm: {
        "default-provider": "openai",
        "default-model": "gpt-4o",
        providers: {},
      },
      ask: { "confirm-threshold": 0.5 },
      agents: { "data-dir": "/tmp/x" },
    };

    assert.deepEqual(decodeFromYaml(input), {
      llm: {
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        providers: {},
      },
      ask: { confirmThreshold: 0.5 },
      agents: { dataDir: "/tmp/x" },
    });
  });

  it("should preserve dynamic record keys at llm.providers (single-level record)", () => {
    const input = {
      llm: {
        providers: {
          openai: { "api-key": "sk-1", "base-url": "https://example.com" },
          "custom-provider": { "api-key": "sk-2" },
        },
      },
    };

    const result = decodeFromYaml(input) as {
      llm: { providers: Record<string, { apiKey?: string; baseUrl?: string }> };
    };

    assert.ok("openai" in result.llm.providers);
    assert.ok("custom-provider" in result.llm.providers);
    assert.equal(result.llm.providers["openai"]?.apiKey, "sk-1");
    assert.equal(result.llm.providers["openai"]?.baseUrl, "https://example.com");
    assert.equal(result.llm.providers["custom-provider"]?.apiKey, "sk-2");
  });

  it("should preserve keys at both levels of agents.env (nested record)", () => {
    const input = {
      agents: {
        env: {
          "smart-reply-agent": { REPLY_AUTHORITY_URL: "https://x" },
          "browser-use-agent": { REPLY_AUTHORITY_KEYS_URL: "https://y" },
        },
      },
    };

    const result = decodeFromYaml(input) as {
      agents: { env: Record<string, Record<string, string>> };
    };

    assert.ok("smart-reply-agent" in result.agents.env);
    assert.ok("browser-use-agent" in result.agents.env);
    assert.equal(result.agents.env["smart-reply-agent"]?.REPLY_AUTHORITY_URL, "https://x");
    assert.equal(result.agents.env["browser-use-agent"]?.REPLY_AUTHORITY_KEYS_URL, "https://y");
  });

  it("should leave unknown schema fields as identity (not recurse into camel rules)", () => {
    const input = {
      futureSection: {
        "some-field": "value",
      },
    };

    const result = decodeFromYaml(input) as Record<string, unknown>;
    assert.ok("futureSection" in result);
    assert.deepEqual(result["futureSection"], { "some-field": "value" });
  });
});

describe("key-codec: encodePathToYaml", () => {
  it("should normalize schema object fields to kebab-case (kebab input)", () => {
    assert.deepEqual(encodePathToYaml(["llm", "default-provider"]), ["llm", "default-provider"]);
  });

  it("should normalize schema object fields to kebab-case (camel input)", () => {
    assert.deepEqual(encodePathToYaml(["llm", "defaultProvider"]), ["llm", "default-provider"]);
  });

  it("should preserve record keys at llm.providers", () => {
    assert.deepEqual(encodePathToYaml(["llm", "providers", "openai", "apiKey"]), [
      "llm",
      "providers",
      "openai",
      "api-key",
    ]);
    assert.deepEqual(encodePathToYaml(["llm", "providers", "custom-provider", "base-url"]), [
      "llm",
      "providers",
      "custom-provider",
      "base-url",
    ]);
  });

  it("should preserve both record levels in agents.env without kebab transform", () => {
    assert.deepEqual(
      encodePathToYaml(["agents", "env", "smart-reply-agent", "REPLY_AUTHORITY_URL"]),
      ["agents", "env", "smart-reply-agent", "REPLY_AUTHORITY_URL"],
    );
  });

  it("should not kebab-ify SCREAMING_SNAKE_CASE env var names", () => {
    assert.deepEqual(encodePathToYaml(["agents", "env", "notify-agent", "FEISHU_BOT_WEBHOOK"]), [
      "agents",
      "env",
      "notify-agent",
      "FEISHU_BOT_WEBHOOK",
    ]);
  });

  it("should not transform a camelCase record key (user input flows through untouched)", () => {
    assert.deepEqual(
      encodePathToYaml(["agents", "env", "smartReplyAgent", "REPLY_AUTHORITY_URL"]),
      ["agents", "env", "smartReplyAgent", "REPLY_AUTHORITY_URL"],
    );
  });
});

describe("key-codec: normalizeUserPath", () => {
  it("should normalize schema object fields to camelCase (kebab input)", () => {
    assert.deepEqual(normalizeUserPath(["llm", "default-provider"]), ["llm", "defaultProvider"]);
  });

  it("should normalize schema object fields to camelCase (camel input)", () => {
    assert.deepEqual(normalizeUserPath(["llm", "defaultProvider"]), ["llm", "defaultProvider"]);
  });

  it("should preserve record keys at agents.env (both levels)", () => {
    assert.deepEqual(
      normalizeUserPath(["agents", "env", "smart-reply-agent", "REPLY_AUTHORITY_URL"]),
      ["agents", "env", "smart-reply-agent", "REPLY_AUTHORITY_URL"],
    );
  });

  it("should preserve record keys at llm.providers then camelize provider fields", () => {
    assert.deepEqual(normalizeUserPath(["llm", "providers", "openai", "api-key"]), [
      "llm",
      "providers",
      "openai",
      "apiKey",
    ]);
  });
});

describe("key-codec: string helpers", () => {
  it("kebabToCamel handles multi-dash names", () => {
    assert.equal(kebabToCamel("smart-reply-agent"), "smartReplyAgent");
    assert.equal(kebabToCamel("default-provider"), "defaultProvider");
    assert.equal(kebabToCamel("already-lower"), "alreadyLower");
    assert.equal(kebabToCamel("noChange"), "noChange");
  });

  it("camelToKebab handles multi-cap names", () => {
    assert.equal(camelToKebab("smartReplyAgent"), "smart-reply-agent");
    assert.equal(camelToKebab("defaultProvider"), "default-provider");
    assert.equal(camelToKebab("lowercase"), "lowercase");
  });
});
