import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnosticStatus } from "./diagnostic-status.ts";

describe("diagnostic_status", () => {
  it("requires effectiveEnvSources in the output schema", () => {
    const missingField = diagnosticStatus.output.safeParse({});

    if (missingField.success) {
      assert.fail("diagnostic_status output should require effectiveEnvSources");
    }

    assert.equal(missingField.error.issues[0]?.path[0], "effectiveEnvSources");
  });

  it("accepts present and missing effective env entries", () => {
    const parsed = diagnosticStatus.output.parse({
      effectiveEnvSources: {
        REPLY_AUTHORITY_URL: { present: true, fingerprint: "0123abcd" },
        REPLY_AUTHORITY_BEARER_TOKEN: { present: false },
      },
    });

    assert.equal(parsed.effectiveEnvSources["REPLY_AUTHORITY_URL"]?.present, true);
    assert.equal(parsed.effectiveEnvSources["REPLY_AUTHORITY_URL"]?.fingerprint, "0123abcd");
    assert.equal(parsed.effectiveEnvSources["REPLY_AUTHORITY_BEARER_TOKEN"]?.present, false);
  });
});
