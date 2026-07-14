import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createConfiguredSecretPathKeys,
  findConfiguredSecretSentinelAtOrBelow,
  resolveConfigSecretPresentation,
} from "./config-secret.ts";
import { resolveSecretInputValue } from "../app-state.ts";
import { SECRET_SENTINEL } from "../types.ts";

describe("Roll UI dynamic secret presentation", () => {
  it("treats a snapshot-declared path as a configured secret even when catalog metadata is false", () => {
    const path = ["agents", "env", "demo-agent", "PUBLIC_ENDPOINT"] as const;
    const keys = createConfiguredSecretPathKeys([path]);

    assert.deepEqual(resolveConfigSecretPresentation(false, path, keys, SECRET_SENTINEL), {
      secret: true,
      configured: true,
    });
    assert.equal(resolveSecretInputValue("", true), SECRET_SENTINEL);
  });

  it("keeps an ordinary URL field non-secret", () => {
    const path = ["install", "registry"] as const;
    assert.deepEqual(resolveConfigSecretPresentation(false, path, new Set(), "https://npm.test"), {
      secret: false,
      configured: false,
    });
  });

  it("does not restore a sentinel for a newly entered secret with no existing value", () => {
    const path = ["browser", "instances", "work", "cdpUrl"] as const;
    const dynamicPresentation = resolveConfigSecretPresentation(
      false,
      path,
      createConfiguredSecretPathKeys([path]),
      "wss://new-secret.test",
    );
    const staticPresentation = resolveConfigSecretPresentation(
      true,
      ["llm", "providers", "openai", "apiKey"],
      new Set(),
      "new-api-key",
    );

    assert.equal(dynamicPresentation.configured, false);
    assert.equal(staticPresentation.configured, false);
    assert.equal(resolveSecretInputValue("", dynamicPresentation.configured), "");
    assert.equal(resolveSecretInputValue("", staticPresentation.configured), "");
  });

  it("finds a nested configured secret sentinel before a dynamic record rename", () => {
    const secretPath = ["llm", "providers", "old", "nested", "apiKey"] as const;
    const persisted = {
      llm: {
        providers: {
          old: { nested: { apiKey: SECRET_SENTINEL }, label: "keep" },
          sibling: { apiKey: SECRET_SENTINEL },
        },
      },
    };
    const keys = createConfiguredSecretPathKeys([
      secretPath,
      ["llm", "providers", "sibling", "apiKey"],
    ]);

    assert.deepEqual(
      findConfiguredSecretSentinelAtOrBelow(persisted, ["llm", "providers", "old"], keys),
      secretPath,
    );
    assert.equal(
      findConfiguredSecretSentinelAtOrBelow(
        { llm: { providers: { old: { apiKey: "replacement" } } } },
        ["llm", "providers", "old"],
        keys,
      ),
      undefined,
    );
  });

  it("treats a value-aware Agent path as secret even when env metadata says false", () => {
    const path = ["agents", "env", "notify-agent", "PUBLIC_ENDPOINT"] as const;
    const presentation = resolveConfigSecretPresentation(
      false,
      path,
      createConfiguredSecretPathKeys([path]),
      SECRET_SENTINEL,
    );

    assert.deepEqual(presentation, { secret: true, configured: true });
  });
});
