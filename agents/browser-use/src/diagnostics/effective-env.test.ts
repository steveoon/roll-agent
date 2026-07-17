import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BROWSER_USE_DECLARED_ENV_KEYS, collectEffectiveEnvSources } from "./effective-env.ts";

describe("browser-use effective environment diagnostics", () => {
  it("reports the Reply Authority caller timeout without exposing its value", () => {
    assert.equal(BROWSER_USE_DECLARED_ENV_KEYS.includes("REPLY_AUTHORITY_TIMEOUT_MS"), true);

    const sources = collectEffectiveEnvSources(BROWSER_USE_DECLARED_ENV_KEYS, {
      REPLY_AUTHORITY_TIMEOUT_MS: "60000",
    });

    assert.equal(sources["REPLY_AUTHORITY_TIMEOUT_MS"]?.present, true);
    assert.match(sources["REPLY_AUTHORITY_TIMEOUT_MS"]?.fingerprint ?? "", /^[0-9a-f]{8}$/);
    assert.equal(JSON.stringify(sources).includes("60000"), false);
  });
});
