import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  formatAgentSourceType,
  parsePackageName,
  resolveInstalledPackageRoot,
  sanitizeInstallId,
} from "./source.ts";

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-source-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

  it("resolves installed package roots for tarball installs via install manifest", () => {
    const installDir = makeTmpDir();

    try {
      const packageRoot = resolve(installDir, "node_modules", "@roll-agent", "tgz-agent");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        resolve(installDir, "package.json"),
        JSON.stringify({
          dependencies: {
            "@roll-agent/tgz-agent": "file:../../tgz-agent-1.0.0.tgz",
          },
        }),
        "utf-8",
      );
      writeFileSync(
        resolve(packageRoot, "package.json"),
        '{"name":"@roll-agent/tgz-agent"}',
        "utf-8",
      );
      writeFileSync(
        resolve(packageRoot, "SKILL.md"),
        "---\nname: tgz-agent\ndescription: tgz\n---\n",
        "utf-8",
      );

      assert.equal(
        resolveInstalledPackageRoot(installDir, "/tmp/dist/tgz-agent-1.0.0.tgz"),
        packageRoot,
      );
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("falls back to scanning node_modules when tarball install metadata is unavailable", () => {
    const installDir = makeTmpDir();

    try {
      const packageRoot = resolve(installDir, "node_modules", "tgz-agent");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(resolve(packageRoot, "package.json"), '{"name":"tgz-agent"}', "utf-8");
      writeFileSync(
        resolve(packageRoot, "SKILL.md"),
        "---\nname: tgz-agent\ndescription: tgz\n---\n",
        "utf-8",
      );

      assert.equal(
        resolveInstalledPackageRoot(installDir, "/tmp/dist/tgz-agent-1.0.0.tgz"),
        packageRoot,
      );
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("formats source labels for CLI display", () => {
    assert.equal(formatAgentSourceType("local-path"), "local-path");
    assert.equal(formatAgentSourceType("installed-package"), "installed");
  });
});
