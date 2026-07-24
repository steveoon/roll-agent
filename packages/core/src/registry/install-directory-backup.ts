import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const INSTALL_DIRECTORY_BACKUP_KINDS = {
  existingBackedUp: "existing-backed-up",
  missingCreated: "missing-created",
} as const;

interface ExistingInstallDirectoryBackup {
  readonly kind: typeof INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp;
  readonly installDir: string;
  readonly backupDir: string;
}

interface MissingInstallDirectoryBackup {
  readonly kind: typeof INSTALL_DIRECTORY_BACKUP_KINDS.missingCreated;
  readonly installDir: string;
}

export type InstallDirectoryBackup = ExistingInstallDirectoryBackup | MissingInstallDirectoryBackup;

/**
 * Moves an existing install directory aside, or records that the stable prefix was absent, before
 * creating the prefix used by the package manager.
 *
 * Package-manager lifecycle scripts still observe the registered final prefix, while callers can
 * restore the complete previous state if download, discovery, setup, or readiness later fails.
 */
export function beginInstallDirectoryReplacement(installDir: string): InstallDirectoryBackup {
  const resolvedInstallDir = resolve(installDir);
  const stats = lstatSync(resolvedInstallDir, { throwIfNoEntry: false });
  if (stats === undefined) {
    mkdirSync(dirname(resolvedInstallDir), { recursive: true });
    mkdirSync(resolvedInstallDir);
    return {
      kind: INSTALL_DIRECTORY_BACKUP_KINDS.missingCreated,
      installDir: resolvedInstallDir,
    };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Agent 安装目录必须是普通目录: ${resolvedInstallDir}`);
  }

  const backupDir = resolve(
    dirname(resolvedInstallDir),
    `.${basename(resolvedInstallDir)}.rollback-${randomUUID()}`,
  );
  renameSync(resolvedInstallDir, backupDir);
  try {
    mkdirSync(resolvedInstallDir);
  } catch (error) {
    renameSync(backupDir, resolvedInstallDir);
    throw error;
  }
  return {
    kind: INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp,
    installDir: resolvedInstallDir,
    backupDir,
  };
}

export function restoreInstallDirectoryBackup(backup: InstallDirectoryBackup): void {
  rmSync(backup.installDir, { recursive: true, force: true });
  if (backup.kind === INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp) {
    renameSync(backup.backupDir, backup.installDir);
  }
}

export function discardInstallDirectoryBackup(backup: InstallDirectoryBackup): void {
  if (backup.kind === INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp) {
    rmSync(backup.backupDir, { recursive: true, force: true });
  }
}

export function getInstallDirectoryBackupPath(backup: InstallDirectoryBackup): string | undefined {
  return backup.kind === INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp
    ? backup.backupDir
    : undefined;
}
