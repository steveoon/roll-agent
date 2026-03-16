import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgentSourceType,
  parsePackageName,
  resolveInstalledPackageRoot,
  sanitizeInstallId,
} from "./source.ts";

describe("registry/source", () => {
  it("parses unscoped package specs", () => {
    assert.equal(parsePackageName("smart-reply-agent@latest"), "smart-reply-agent");
    assert.equal(parsePackageName("smart-reply-agent"), "smart-reply-agent");
  });

  it("parses scoped package specs", () => {
    assert.equal(
      parsePackageName("@roll-agent/smart-reply-agent@1.2.3"),
      "@roll-agent/smart-reply-agent",
    );
    assert.equal(
      parsePackageName("@roll-agent/smart-reply-agent"),
      "@roll-agent/smart-reply-agent",
    );
  });

  it("sanitizes install ids for filesystem usage", () => {
    assert.equal(sanitizeInstallId("@roll-agent/smart reply"), "roll-agent-smart-reply");
  });

  it("resolves installed package roots inside node_modules", () => {
    assert.equal(
      resolveInstalledPackageRoot("/tmp/roll/installed/pkg", "@roll-agent/smart-reply-agent"),
      "/tmp/roll/installed/pkg/node_modules/@roll-agent/smart-reply-agent",
    );
  });

  it("formats source labels for CLI display", () => {
    assert.equal(formatAgentSourceType("local"), "local-path");
    assert.equal(formatAgentSourceType("installed"), "installed");
  });
});
