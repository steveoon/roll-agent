import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasSecretTerminalName,
  isCredentialBearingUrl,
  isSecretConfigValue,
} from "./secret-policy.ts";

describe("config secret policy", () => {
  it("recognizes exact terminal secret names across common naming conventions", () => {
    for (const name of [
      "accessToken",
      "access-token",
      "ACCESS_TOKEN",
      "clientSecret",
      "db_password",
      "serviceWebhook",
      "serviceWebhookUrl",
      "apiKey",
      "private-key",
    ]) {
      assert.equal(hasSecretTerminalName(["future", name]), true, name);
    }
  });

  it("does not redact operational names that merely contain secret-related words", () => {
    for (const name of [
      "maxOutputTokens",
      "tokenBudget",
      "secretRotation",
      "passwordPolicy",
      "webhookRetryCount",
      "apiKeyRotation",
    ]) {
      assert.equal(hasSecretTerminalName(["future", name]), false, name);
      assert.equal(
        isSecretConfigValue(["future", name], "ordinary-value", () => false),
        false,
      );
    }
  });

  it("detects URL user-info and credential parameters but not ordinary URL metadata", () => {
    for (const value of [
      "https://user:password@example.test/v1",
      "https://example.test/v1?access_token=opaque",
      "https://example.test/v1?api-key=opaque",
      "https://example.test/v1?apikey=opaque",
      "https://example.test/v1#client_secret=opaque",
      "https://example.test/v1?X-Amz-Signature=opaque",
      "https://example.test/v1?sig=opaque",
      "https://example.test/v1?auth=opaque",
      "https://user:password@",
    ]) {
      assert.equal(isCredentialBearingUrl(value), true, value);
    }

    for (const value of [
      "https://example.test/v1",
      "https://example.test/v1?api-version=2026-07-14",
      "https://example.test/v1?token-budget=1000",
      "not a URL with token budget",
      "release notes?auth=disabled",
    ]) {
      assert.equal(isCredentialBearingUrl(value), false, value);
    }
  });

  it("lets the Agent env contract override token-like names while retaining URL fail-closed", () => {
    const path = ["agents", "env", "demo-agent", "PUBLIC_TOKEN"] as const;
    assert.equal(
      isSecretConfigValue(path, "public-label", () => false),
      false,
    );
    assert.equal(
      isSecretConfigValue(path, "https://user:password@example.test", () => false),
      true,
    );
  });
});
