import {
  discardInstallDirectoryBackup,
  restoreInstallDirectoryBackup,
  type InstallDirectoryBackup,
} from "./install-directory-backup.ts";
import {
  MANAGED_AGENT_RUNTIME_RETENTIONS,
  type ManagedAgentRuntimeRetention,
} from "./process-manager.ts";
import type { RegisteredAgent } from "../types/agent.ts";

export const INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS = {
  unchanged: "unchanged",
  backedUp: "backed-up",
  replaced: "replaced",
  stopped: "stopped",
} as const;

export const INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS = {
  restored: "restored",
  partial: "partial",
} as const;

export const INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS = {
  notNeeded: "not-needed",
  eligible: "eligible",
  blocked: "blocked",
} as const;

export const INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS = {
  registration: "registration",
  directory: "directory",
} as const;

export const INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS = {
  committed: "committed",
  cleanupFailed: "cleanup-failed",
} as const;

interface UnchangedDirectoryBaseline {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.unchanged;
}

interface BackedUpDirectoryBaseline {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.backedUp;
  readonly backup: InstallDirectoryBackup;
}

type InstalledPackageDirectoryBaseline = UnchangedDirectoryBaseline | BackedUpDirectoryBaseline;

interface UnchangedRegistrationBaseline {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.unchanged;
}

interface ReplacedRegistrationBaseline {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.replaced;
  readonly previous: RegisteredAgent;
  readonly replacementName: string;
}

type InstalledPackageRegistrationBaseline =
  | UnchangedRegistrationBaseline
  | ReplacedRegistrationBaseline;

interface UnchangedRuntimeBaseline {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.unchanged;
}

export interface StoppedManagedRuntimeBaseline {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.stopped;
  readonly agent: RegisteredAgent;
  readonly retention: ManagedAgentRuntimeRetention;
}

type InstalledPackageRuntimeBaseline = UnchangedRuntimeBaseline | StoppedManagedRuntimeBaseline;

export interface InstalledPackageReplacement {
  readonly directory: InstalledPackageDirectoryBaseline;
  readonly registration: InstalledPackageRegistrationBaseline;
  readonly runtime: InstalledPackageRuntimeBaseline;
}

export interface InstalledPackageReplacementStore {
  replace(name: string, agent: RegisteredAgent): boolean;
}

export interface InstalledPackageRegistrationRollbackFailure {
  readonly step: typeof INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS.registration;
  readonly error: unknown;
}

export interface InstalledPackageDirectoryRollbackFailure {
  readonly step: typeof INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS.directory;
  readonly error: unknown;
  readonly backup: InstallDirectoryBackup;
}

export type InstalledPackageReplacementRollbackFailure =
  | InstalledPackageRegistrationRollbackFailure
  | InstalledPackageDirectoryRollbackFailure;

interface InstalledPackageRuntimeRecoveryNotNeeded {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.notNeeded;
}

interface InstalledPackageRuntimeRecoveryEligible {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.eligible;
  readonly baseline: StoppedManagedRuntimeBaseline;
}

interface InstalledPackageRuntimeRecoveryBlocked {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.blocked;
}

export type InstalledPackageReplacementRuntimeRecovery =
  | InstalledPackageRuntimeRecoveryNotNeeded
  | InstalledPackageRuntimeRecoveryEligible
  | InstalledPackageRuntimeRecoveryBlocked;

export interface InstalledPackageReplacementRestored {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.restored;
  readonly runtimeRecovery:
    | InstalledPackageRuntimeRecoveryNotNeeded
    | InstalledPackageRuntimeRecoveryEligible;
}

export interface InstalledPackageReplacementPartiallyRestored {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.partial;
  readonly failures: readonly InstalledPackageReplacementRollbackFailure[];
  readonly runtimeRecovery: InstalledPackageRuntimeRecoveryBlocked;
}

export type InstalledPackageReplacementRollbackOutcome =
  | InstalledPackageReplacementRestored
  | InstalledPackageReplacementPartiallyRestored;

export interface InstalledPackageReplacementCommitted {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.committed;
}

export interface InstalledPackageReplacementCommitCleanupFailed {
  readonly kind: typeof INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.cleanupFailed;
  readonly error: unknown;
  readonly backup: InstallDirectoryBackup;
}

export type InstalledPackageReplacementCommitOutcome =
  | InstalledPackageReplacementCommitted
  | InstalledPackageReplacementCommitCleanupFailed;

interface InstalledPackageReplacementCollaborators {
  readonly restoreDirectory: typeof restoreInstallDirectoryBackup;
  readonly discardDirectory: typeof discardInstallDirectoryBackup;
}

const DEFAULT_COLLABORATORS: InstalledPackageReplacementCollaborators = {
  restoreDirectory: restoreInstallDirectoryBackup,
  discardDirectory: discardInstallDirectoryBackup,
};

export function createInstalledPackageReplacement(): InstalledPackageReplacement {
  return {
    directory: { kind: INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.unchanged },
    registration: { kind: INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.unchanged },
    runtime: { kind: INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.unchanged },
  };
}

export function recordInstalledPackageDirectoryBackup(
  replacement: InstalledPackageReplacement,
  backup: InstallDirectoryBackup,
): InstalledPackageReplacement {
  return {
    ...replacement,
    directory: {
      kind: INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.backedUp,
      backup,
    },
  };
}

export function recordInstalledPackageRegistrationReplacement(
  replacement: InstalledPackageReplacement,
  previous: RegisteredAgent,
  replacementName: string,
): InstalledPackageReplacement {
  return {
    ...replacement,
    registration: {
      kind: INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.replaced,
      previous,
      replacementName,
    },
  };
}

export function recordInstalledPackageStoppedRuntime(
  replacement: InstalledPackageReplacement,
  agent: RegisteredAgent,
  retention: ManagedAgentRuntimeRetention,
): InstalledPackageReplacement {
  return {
    ...replacement,
    runtime: {
      kind: INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.stopped,
      agent,
      retention,
    },
  };
}

export function getInstalledPackageStoppedRuntime(
  replacement: InstalledPackageReplacement,
): StoppedManagedRuntimeBaseline | undefined {
  return replacement.runtime.kind === INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.stopped
    ? replacement.runtime
    : undefined;
}

export function rollbackInstalledPackageReplacement(
  replacement: InstalledPackageReplacement,
  store: InstalledPackageReplacementStore,
  options: {
    readonly collaborators?: Partial<InstalledPackageReplacementCollaborators>;
  } = {},
): InstalledPackageReplacementRollbackOutcome {
  const collaborators = {
    ...DEFAULT_COLLABORATORS,
    ...options.collaborators,
  };
  const failures: InstalledPackageReplacementRollbackFailure[] = [];

  if (replacement.registration.kind === INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.replaced) {
    try {
      if (
        !store.replace(replacement.registration.replacementName, replacement.registration.previous)
      ) {
        throw new Error(
          `Agent "${replacement.registration.replacementName}" 已从注册表中移除，无法恢复旧注册信息`,
        );
      }
    } catch (error) {
      failures.push({
        step: INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS.registration,
        error,
      });
    }
  }

  if (replacement.directory.kind === INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.backedUp) {
    try {
      collaborators.restoreDirectory(replacement.directory.backup);
    } catch (error) {
      failures.push({
        step: INSTALLED_PACKAGE_REPLACEMENT_FAILURE_STEPS.directory,
        error,
        backup: replacement.directory.backup,
      });
    }
  }

  if (failures.length > 0) {
    return {
      kind: INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.partial,
      failures,
      runtimeRecovery: {
        kind: INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.blocked,
      },
    };
  }

  const runtimeRecovery: InstalledPackageReplacementRestored["runtimeRecovery"] =
    replacement.runtime.kind === INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.stopped &&
    replacement.runtime.retention === MANAGED_AGENT_RUNTIME_RETENTIONS.persistent
      ? {
          kind: INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.eligible,
          baseline: replacement.runtime,
        }
      : {
          kind: INSTALLED_PACKAGE_REPLACEMENT_RUNTIME_RECOVERY_KINDS.notNeeded,
        };

  return {
    kind: INSTALLED_PACKAGE_REPLACEMENT_ROLLBACK_KINDS.restored,
    runtimeRecovery,
  };
}

export function commitInstalledPackageReplacement(
  replacement: InstalledPackageReplacement,
  options: {
    readonly collaborators?: Partial<InstalledPackageReplacementCollaborators>;
  } = {},
): InstalledPackageReplacementCommitOutcome {
  if (replacement.directory.kind !== INSTALLED_PACKAGE_REPLACEMENT_BASELINE_KINDS.backedUp) {
    return { kind: INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.committed };
  }

  const collaborators = {
    ...DEFAULT_COLLABORATORS,
    ...options.collaborators,
  };
  try {
    collaborators.discardDirectory(replacement.directory.backup);
    return { kind: INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.committed };
  } catch (error) {
    return {
      kind: INSTALLED_PACKAGE_REPLACEMENT_COMMIT_KINDS.cleanupFailed,
      error,
      backup: replacement.directory.backup,
    };
  }
}
