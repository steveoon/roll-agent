import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  CONFIG_KEY_CODEC,
  buildKeyCodecNode,
  camelToKebab,
  decodeFromYaml,
  encodePathToYaml,
  encodeToYaml,
  kebabToCamel,
  normalizeUserPath,
} from "./key-codec.ts";
import { rollConfigSchema } from "./schema.ts";

describe("key-codec: schema derivation", () => {
  it("derives every root configuration field from rollConfigSchema", () => {
    assert.equal(CONFIG_KEY_CODEC.kind, "object");
    assert.deepEqual(Object.keys(CONFIG_KEY_CODEC.fields), Object.keys(rollConfigSchema.shape));
  });

  it("supports wrapped records and array item object paths without another field list", () => {
    const schema = z.object({
      futureSection: z
        .object({
          items: z.array(z.object({ someField: z.string() })).default([]),
          entries: z.record(z.string(), z.object({ nestedValue: z.number() })),
        })
        .optional(),
    });
    const codec = buildKeyCodecNode(schema);
    const yamlValue = {
      "future-section": {
        items: [{ "some-field": "value" }],
        entries: { "dynamic-key": { "nested-value": 1 } },
      },
    };
    const canonicalValue = {
      futureSection: {
        items: [{ someField: "value" }],
        entries: { "dynamic-key": { nestedValue: 1 } },
      },
    };

    assert.deepEqual(decodeFromYaml(yamlValue, codec), canonicalValue);
    assert.deepEqual(encodeToYaml(canonicalValue, codec), yamlValue);
    assert.deepEqual(encodePathToYaml(["futureSection", "items", "0", "someField"], codec), [
      "future-section",
      "items",
      "0",
      "some-field",
    ]);
    assert.deepEqual(normalizeUserPath(["future-section", "items", "0", "some-field"], codec), [
      "futureSection",
      "items",
      "0",
      "someField",
    ]);
    assert.deepEqual(
      encodePathToYaml(["futureSection", "entries", "dynamic-key", "nestedValue"], codec),
      ["future-section", "entries", "dynamic-key", "nested-value"],
    );
  });
});

describe("key-codec: decodeFromYaml", () => {
  it("should convert kebab-case schema fields to camelCase", () => {
    const input = {
      llm: {
        "default-provider": "openai",
        "default-model": "gpt-5.5",
        providers: {},
      },
      ask: { "confirm-threshold": 0.5 },
      runtime: {
        "max-steps": 7,
        "turn-timeout-ms": 45_000,
        "threads-dir": "~/threads",
        "context-window": 128_000,
        "thinking-level": "high",
        approval: {
          default: "auto",
          overrides: {
            "browser-use-agent.browser_status": "confirm",
          },
        },
        compaction: {
          "timeout-ms": 180_000,
          "thinking-level": "high",
          "max-output-tokens": 16_384,
          "keep-recent-turns": 6,
        },
      },
      agents: { "data-dir": "/tmp/x" },
    };

    assert.deepEqual(decodeFromYaml(input), {
      llm: {
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        providers: {},
      },
      ask: { confirmThreshold: 0.5 },
      runtime: {
        maxSteps: 7,
        turnTimeoutMs: 45_000,
        threadsDir: "~/threads",
        contextWindow: 128_000,
        thinkingLevel: "high",
        approval: {
          default: "auto",
          overrides: {
            "browser-use-agent.browser_status": "confirm",
          },
        },
        compaction: {
          timeoutMs: 180_000,
          thinkingLevel: "high",
          maxOutputTokens: 16_384,
          keepRecentTurns: 6,
        },
      },
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

  it("should preserve browser instance ids while camelizing instance fields", () => {
    const input = {
      browser: {
        "default-instance": "boss-a",
        instances: {
          "boss-a": {
            "cdp-port": 9222,
            "user-data-dir": "/tmp/boss-a",
            "profile-name": "Boss A",
            "profile-color": "#dc2626",
            "window-bounds": {
              x: 0,
              y: 24,
              width: 680,
              height: 1000,
            },
            "tracking-agent-id": "zhipin-boss-a",
          },
        },
      },
    };

    const result = decodeFromYaml(input) as {
      browser: {
        defaultInstance: string;
        instances: Record<
          string,
          {
            cdpPort: number;
            userDataDir: string;
            profileName: string;
            profileColor: string;
            windowBounds: { x: number; y: number; width: number; height: number };
            trackingAgentId: string;
          }
        >;
      };
    };

    assert.equal(result.browser.defaultInstance, "boss-a");
    assert.equal(result.browser.instances["boss-a"]?.cdpPort, 9222);
    assert.equal(result.browser.instances["boss-a"]?.userDataDir, "/tmp/boss-a");
    assert.equal(result.browser.instances["boss-a"]?.profileName, "Boss A");
    assert.equal(result.browser.instances["boss-a"]?.profileColor, "#dc2626");
    assert.deepEqual(result.browser.instances["boss-a"]?.windowBounds, {
      x: 0,
      y: 24,
      width: 680,
      height: 1000,
    });
    assert.equal(result.browser.instances["boss-a"]?.trackingAgentId, "zhipin-boss-a");
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

describe("key-codec: encodeToYaml", () => {
  it("should encode schema keys and preserve every dynamic record key", () => {
    const input = {
      skills: { dirs: ["./skills"] },
      runtime: {
        turnTimeoutMs: 60_000,
        compaction: {
          timeoutMs: 180_000,
          thinkingLevel: "high",
          maxOutputTokens: 16_384,
        },
        approval: {
          overrides: {
            "roll.exec_command": "auto",
          },
        },
      },
      agents: {
        env: {
          "browser-use-agent": {
            REPLY_AUTHORITY_BEARER_TOKEN: `\${REPLY_AUTHORITY_BEARER_TOKEN}`,
          },
        },
      },
      browser: {
        instances: {
          "boss-a": {
            cdpPort: 9222,
            userDataDir: "~/.roll-agent/browser/boss-a",
            windowBounds: { width: 680, height: 1000 },
          },
        },
      },
    };

    assert.deepEqual(encodeToYaml(input), {
      skills: { dirs: ["./skills"] },
      runtime: {
        "turn-timeout-ms": 60_000,
        compaction: {
          "timeout-ms": 180_000,
          "thinking-level": "high",
          "max-output-tokens": 16_384,
        },
        approval: {
          overrides: {
            "roll.exec_command": "auto",
          },
        },
      },
      agents: {
        env: {
          "browser-use-agent": {
            REPLY_AUTHORITY_BEARER_TOKEN: `\${REPLY_AUTHORITY_BEARER_TOKEN}`,
          },
        },
      },
      browser: {
        instances: {
          "boss-a": {
            "cdp-port": 9222,
            "user-data-dir": "~/.roll-agent/browser/boss-a",
            "window-bounds": { width: 680, height: 1000 },
          },
        },
      },
    });
  });

  it("should round-trip supported configuration structures", () => {
    const input = {
      llm: {
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        providers: {
          "custom-provider": {
            apiKey: `\${CUSTOM_API_KEY}`,
            baseUrl: "https://example.com/v1",
          },
        },
      },
      ask: { confirmThreshold: 0.6 },
    };

    assert.deepEqual(decodeFromYaml(encodeToYaml(input)), input);
  });
});

describe("key-codec: encodePathToYaml", () => {
  it("should normalize schema object fields to kebab-case (kebab input)", () => {
    assert.deepEqual(encodePathToYaml(["llm", "default-provider"]), ["llm", "default-provider"]);
  });

  it("should normalize schema object fields to kebab-case (camel input)", () => {
    assert.deepEqual(encodePathToYaml(["llm", "defaultProvider"]), ["llm", "default-provider"]);
  });

  it("should retain dotted record keys instead of treating them as nested config fields", () => {
    assert.deepEqual(
      normalizeUserPath(["runtime", "approval", "overrides", "roll", "exec_command"]),
      ["runtime", "approval", "overrides", "roll.exec_command"],
    );
    assert.deepEqual(encodePathToYaml(["llm", "providers", "gateway", "v1", "api-key"]), [
      "llm",
      "providers",
      "gateway.v1",
      "api-key",
    ]);
  });

  it("should normalize runtime config fields to kebab-case", () => {
    assert.deepEqual(encodePathToYaml(["runtime", "maxSteps"]), ["runtime", "max-steps"]);
    assert.deepEqual(encodePathToYaml(["runtime", "threadsDir"]), ["runtime", "threads-dir"]);
    assert.deepEqual(encodePathToYaml(["runtime", "approval", "default"]), [
      "runtime",
      "approval",
      "default",
    ]);
    assert.deepEqual(
      encodePathToYaml(["runtime", "approval", "overrides", "browser-use-agent.browser_status"]),
      ["runtime", "approval", "overrides", "browser-use-agent.browser_status"],
    );
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

  it("should preserve browser instance ids when encoding fields", () => {
    assert.deepEqual(encodePathToYaml(["browser", "instances", "boss-a", "trackingAgentId"]), [
      "browser",
      "instances",
      "boss-a",
      "tracking-agent-id",
    ]);
    assert.deepEqual(encodePathToYaml(["browser", "instances", "boss-a", "windowBounds"]), [
      "browser",
      "instances",
      "boss-a",
      "window-bounds",
    ]);
    assert.deepEqual(
      encodePathToYaml(["browser", "instances", "boss-a", "windowBounds", "width"]),
      ["browser", "instances", "boss-a", "window-bounds", "width"],
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

  it("should normalize runtime config fields to camelCase", () => {
    assert.deepEqual(normalizeUserPath(["runtime", "max-steps"]), ["runtime", "maxSteps"]);
    assert.deepEqual(normalizeUserPath(["runtime", "threads-dir"]), ["runtime", "threadsDir"]);
    assert.deepEqual(normalizeUserPath(["runtime", "approval", "default"]), [
      "runtime",
      "approval",
      "default",
    ]);
    assert.deepEqual(
      normalizeUserPath(["runtime", "approval", "overrides", "browser-use-agent.browser_status"]),
      ["runtime", "approval", "overrides", "browser-use-agent.browser_status"],
    );
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
