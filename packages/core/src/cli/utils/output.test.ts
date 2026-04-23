import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactToolArgsForLog, resolveLogLevelFromArgv } from "./output.ts";

describe("cli/utils/output", () => {
  it("defaults to info log level without verbose flags", () => {
    assert.equal(resolveLogLevelFromArgv(["run", "smart-reply-agent"]), "info");
  });

  it("enables debug log level with --verbose or -v", () => {
    assert.equal(resolveLogLevelFromArgv(["run", "--verbose"]), "debug");
    assert.equal(resolveLogLevelFromArgv(["run", "-v"]), "debug");
  });

  it("redacts sensitive tool arguments recursively", () => {
    const redacted = redactToolArgsForLog({
      signedEnvelope: "payload.signature",
      nested: {
        authToken: "client-test-token",
        recruiter: {
          password: "super-secret",
        },
      },
      cookies: ["a=b", "c=d"],
      safe: "keep-me",
    });

    assert.deepEqual(redacted, {
      signedEnvelope: "[redacted,len=17]",
      nested: {
        authToken: "[redacted,len=17]",
        recruiter: {
          password: "[redacted,len=12]",
        },
      },
      cookies: "[redacted,len=13]",
      safe: "keep-me",
    });
  });
});
