import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultRuntimeForTransport, type RegisteredAgent } from "../types/agent.ts";
import { INSTALL_DIRECTORY_BACKUP_KINDS } from "./install-directory-backup.ts";
import {
  INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS,
  INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS,
  INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS,
  INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS,
  commitInstalledPackageReplacement,
  createInstalledPackageReplacement,
  recordInstalledPackageDirectoryBackup,
  recordInstalledPackageRegistrationReplacement,
  recordInstalledPackageStoppedRuntime,
  rollbackInstalledPackageReplacement,
  type InstalledPackageReplacement,
} from "./installed-package-replacement.ts";
import { MANAGED_AGENT_RUNTIME_RETENTIONS } from "./process-manager.ts";

const AGENT: RegisteredAgent = {
  skill: {
    name: "replacement-test-agent",
    description: "replacement test",
    metadata: {},
  },
  transport: { type: "stdio", command: "node" },
  runtime: createDefaultRuntimeForTransport({ type: "stdio", command: "node" }),
  installPath: "/tmp/replacement-test-agent",
  registeredAt: "2026-07-24T00:00:00.000Z",
  status: "online",
};

function createReplacement(): InstalledPackageReplacement {
  const withRuntime = recordInstalledPackageStoppedRuntime(
    createInstalledPackageReplacement(),
    AGENT,
    MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
  );
  const withDirectory = recordInstalledPackageDirectoryBackup(withRuntime, {
    kind: INSTALL_DIRECTORY_BACKUP_KINDS.missingCreated,
    installDir: "/tmp/replacement-test-agent-install",
  });
  return recordInstalledPackageRegistrationReplacement(withDirectory, AGENT, AGENT.skill.name);
}

describe("InstalledPackageReplacement", () => {
  it("blocks persistent runtime recovery when registration rollback fails", () => {
    const calls: string[] = [];
    const outcome = rollbackInstalledPackageReplacement(
      createReplacement(),
      {
        replace: () => {
          calls.push("registration");
          return false;
        },
      },
      {
        collaborators: {
          restoreDirectory: () => {
            calls.push("directory");
          },
        },
      },
    );

    assert.deepEqual(calls, ["registration", "directory"]);
    assert.equal(outcome.kind, INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.partial);
    if (outcome.kind === INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.partial) {
      assert.deepEqual(
        outcome.failures.map((failure) => failure.step),
        [INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS.registration],
      );
      assert.equal(
        outcome.runtimeRecovery.kind,
        INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.blocked,
      );
    }
  });

  it("blocks persistent runtime recovery when directory rollback fails", () => {
    const calls: string[] = [];
    const outcome = rollbackInstalledPackageReplacement(
      createReplacement(),
      {
        replace: () => {
          calls.push("registration");
          return true;
        },
      },
      {
        collaborators: {
          restoreDirectory: () => {
            calls.push("directory");
            throw new Error("directory restore failed");
          },
        },
      },
    );

    assert.deepEqual(calls, ["registration", "directory"]);
    assert.equal(outcome.kind, INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.partial);
    if (outcome.kind === INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.partial) {
      assert.deepEqual(
        outcome.failures.map((failure) => failure.step),
        [INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS.directory],
      );
      assert.equal(
        outcome.runtimeRecovery.kind,
        INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.blocked,
      );
    }
  });

  it("exposes the persistent runtime baseline only after registration and directory restore", () => {
    const calls: string[] = [];
    const outcome = rollbackInstalledPackageReplacement(
      createReplacement(),
      {
        replace: () => {
          calls.push("registration");
          return true;
        },
      },
      {
        collaborators: {
          restoreDirectory: () => {
            calls.push("directory");
          },
        },
      },
    );

    assert.deepEqual(calls, ["registration", "directory"]);
    assert.equal(outcome.kind, INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.restored);
    if (outcome.kind === INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.restored) {
      assert.equal(
        outcome.runtimeRecovery.kind,
        INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.eligible,
      );
      if (
        outcome.runtimeRecovery.kind ===
        INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.eligible
      ) {
        assert.equal(outcome.runtimeRecovery.baseline.agent, AGENT);
      }
    }
  });

  it("reports commit backup cleanup failure without turning the commit into rollback", () => {
    const outcome = commitInstalledPackageReplacement(createReplacement(), {
      collaborators: {
        discardDirectory: () => {
          throw new Error("backup cleanup failed");
        },
      },
    });

    assert.equal(outcome.kind, INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.cleanupFailed);
    if (outcome.kind === INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.cleanupFailed) {
      assert.match(String(outcome.error), /backup cleanup failed/u);
      assert.equal(outcome.backup.installDir, "/tmp/replacement-test-agent-install");
    }
  });
});
