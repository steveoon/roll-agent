import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { INSTALL_DIRECTORY_BACKUP_KINDS } from "./install-directory-backup.ts";
import {
  INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS,
  INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS,
  INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS,
} from "./installed-package-replacement.ts";
import {
  INSTALLED_PACKAGE_UPDATE_PHASES,
  updateInstalledPackage,
  type InstalledPackageUpdateEvent,
} from "./installed-package-update.ts";

const workRoot = mkdtempSync(join(tmpdir(), "roll-installed-package-update-test-"));

after(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

let caseCounter = 0;

function makeCaseDir(): string {
  caseCounter += 1;
  const caseDir = join(workRoot, `case-${caseCounter}`);
  mkdirSync(caseDir, { recursive: true });
  return caseDir;
}

function makeAgent(installDir: string): RegisteredAgent {
  return {
    skill: {
      name: "installed-update-agent",
      description: "old",
      metadata: {},
    },
    transport: {
      type: "streamable-http",
      endpoint: "http://127.0.0.1:4313/mcp",
    },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: "/mcp", port: 4_313 },
    },
    installPath: join(installDir, "old-package-root"),
    registeredAt: "2026-07-24T00:00:00.000Z",
    status: "online",
    source: {
      type: "installed-package",
      packageName: "@fake/installed-update-agent",
      packageSpec: "@fake/installed-update-agent",
      installDir,
      installedVersion: "1.0.0",
    },
  };
}

describe("updateInstalledPackage", () => {
  it("owns reinstall, discovery, setup, registration and updated runtime restart", async () => {
    const installDir = makeCaseDir();
    const packageRoot = join(installDir, "package-root");
    mkdirSync(packageRoot);
    const agent = makeAgent(installDir);
    const calls: string[] = [];
    const events: InstalledPackageUpdateEvent[] = [];

    const result = await updateInstalledPackage({
      agent,
      install: DEFAULT_CONFIG.install,
      store: {
        replace: (_name, updated) => {
          calls.push(`replace:${updated.skill.description}`);
          return true;
        },
      },
      shouldRestart: true,
      stoppedPersistentAgent: agent,
      resolvePackageSpec: () => "@fake/installed-update-agent@latest",
      restartUpdatedAgent: async (updated) => {
        calls.push(`restart:${updated.skill.description}`);
      },
      report: (event) => events.push(event),
      collaborators: {
        beginDirectoryReplacement: () => ({
          kind: INSTALL_DIRECTORY_BACKUP_KINDS.missingCreated,
          installDir,
        }),
        runInstall: async () => {
          calls.push("install");
          return { stdout: "", stderr: "" };
        },
        resolvePackageRoot: () => packageRoot,
        readManifest: () => ({
          name: "@fake/installed-update-agent",
          version: "2.0.0",
        }),
        discover: () => {
          calls.push("discover");
          return {
            skill: {
              ...agent.skill,
              description: "updated",
            },
            transport: agent.transport,
            runtime: agent.runtime,
            skillPath: join(packageRoot, "SKILL.md"),
            skillBody: "",
          };
        },
        runSetup: async () => {
          calls.push("setup");
          return { ok: true, skipped: true, message: "setup skipped" };
        },
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.agent.skill.description, "updated");
      assert.equal(result.agent.source?.type, "installed-package");
      if (result.agent.source?.type === "installed-package") {
        assert.equal(result.agent.source.installedVersion, "2.0.0");
      }
      assert.equal(result.commit.kind, INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.committed);
    }
    assert.deepEqual(calls, ["install", "discover", "setup", "replace:updated", "restart:updated"]);
    assert.deepEqual(
      events.map((event) => event.type),
      ["install-start", "install-succeeded"],
    );
  });

  it("blocks old runtime recovery when registration rollback fails after restart failure", async () => {
    const installDir = makeCaseDir();
    const packageRoot = join(installDir, "package-root");
    mkdirSync(packageRoot);
    const agent = makeAgent(installDir);
    let replaceCalls = 0;

    const result = await updateInstalledPackage({
      agent,
      install: DEFAULT_CONFIG.install,
      store: {
        replace: () => {
          replaceCalls += 1;
          return replaceCalls === 1;
        },
      },
      shouldRestart: true,
      stoppedPersistentAgent: agent,
      resolvePackageSpec: () => "@fake/installed-update-agent@latest",
      restartUpdatedAgent: async () => {
        throw new Error("restart failed");
      },
      collaborators: {
        beginDirectoryReplacement: () => ({
          kind: INSTALL_DIRECTORY_BACKUP_KINDS.missingCreated,
          installDir,
        }),
        runInstall: async () => ({ stdout: "", stderr: "" }),
        resolvePackageRoot: () => packageRoot,
        readManifest: () => ({
          name: "@fake/installed-update-agent",
          version: "2.0.0",
        }),
        discover: () => ({
          skill: {
            ...agent.skill,
            description: "updated",
          },
          transport: agent.transport,
          runtime: agent.runtime,
          skillPath: join(packageRoot, "SKILL.md"),
          skillBody: "",
        }),
        runSetup: async () => ({ ok: true, skipped: true, message: "setup skipped" }),
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, INSTALLED_PACKAGE_UPDATE_PHASES.activate);
      assert.match(result.message, /restart failed/u);
      assert.equal(result.rollback.kind, INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.partial);
      assert.equal(
        result.rollback.runtimeRecovery.kind,
        INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.blocked,
      );
    }
    assert.equal(replaceCalls, 2);
  });
});
