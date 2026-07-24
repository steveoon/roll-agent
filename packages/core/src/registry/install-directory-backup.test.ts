import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  INSTALL_DIRECTORY_BACKUP_KINDS,
  beginInstallDirectoryReplacement,
  discardInstallDirectoryBackup,
  restoreInstallDirectoryBackup,
} from "./install-directory-backup.ts";

test("install directory replacement restores an existing directory", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "roll-install-backup-"));
  const installDir = resolve(workspace, "agent");
  const oldMarker = resolve(installDir, "old.txt");
  const newMarker = resolve(installDir, "new.txt");
  mkdirSync(installDir);
  writeFileSync(oldMarker, "old", "utf-8");

  try {
    const replacement = beginInstallDirectoryReplacement(installDir);
    assert.equal(replacement.kind, INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp);
    writeFileSync(newMarker, "new", "utf-8");

    restoreInstallDirectoryBackup(replacement);

    assert.equal(readFileSync(oldMarker, "utf-8"), "old");
    assert.equal(existsSync(newMarker), false);
    if (replacement.kind === INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp) {
      assert.equal(existsSync(replacement.backupDir), false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("install directory replacement commits over an existing directory", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "roll-install-backup-"));
  const installDir = resolve(workspace, "agent");
  const oldMarker = resolve(installDir, "old.txt");
  const newMarker = resolve(installDir, "new.txt");
  mkdirSync(installDir);
  writeFileSync(oldMarker, "old", "utf-8");

  try {
    const replacement = beginInstallDirectoryReplacement(installDir);
    writeFileSync(newMarker, "new", "utf-8");

    discardInstallDirectoryBackup(replacement);

    assert.equal(existsSync(oldMarker), false);
    assert.equal(readFileSync(newMarker, "utf-8"), "new");
    if (replacement.kind === INSTALL_DIRECTORY_BACKUP_KINDS.existingBackedUp) {
      assert.equal(existsSync(replacement.backupDir), false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("install directory replacement restores an originally missing directory", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "roll-install-backup-"));
  const installDir = resolve(workspace, "agent");

  try {
    const replacement = beginInstallDirectoryReplacement(installDir);
    assert.equal(replacement.kind, INSTALL_DIRECTORY_BACKUP_KINDS.missingCreated);
    writeFileSync(resolve(installDir, "partial.txt"), "partial", "utf-8");

    restoreInstallDirectoryBackup(replacement);

    assert.equal(existsSync(installDir), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("install directory replacement commits a newly created directory", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "roll-install-backup-"));
  const installDir = resolve(workspace, "agent");
  const newMarker = resolve(installDir, "new.txt");

  try {
    const replacement = beginInstallDirectoryReplacement(installDir);
    writeFileSync(newMarker, "new", "utf-8");

    discardInstallDirectoryBackup(replacement);

    assert.equal(readFileSync(newMarker, "utf-8"), "new");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
