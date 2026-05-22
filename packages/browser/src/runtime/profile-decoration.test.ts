import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decorateManagedProfile } from "./profile-decoration.ts";

function makeTmpUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), `roll-profile-decoration-${randomUUID()}-`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
  assert.ok(isRecord(parsed));
  return parsed;
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  assert.ok(isRecord(child));
  return child;
}

test("decorateManagedProfile refreshes legacy marker when desired profile label changes", () => {
  const userDataDir = makeTmpUserDataDir();
  try {
    writeFileSync(join(userDataDir, ".roll-agent-profile-decorated"), "legacy-marker\n", "utf-8");

    decorateManagedProfile(userDataDir, {
      name: "boss-a",
      color: "#2DD4BF",
    });

    const localState = readJsonRecord(join(userDataDir, "Local State"));
    const profile = getRecord(localState, "profile");
    const infoCache = getRecord(profile, "info_cache");
    const defaultProfile = getRecord(infoCache, "Default");
    assert.equal(defaultProfile["name"], "boss-a");
    assert.match(
      readFileSync(join(userDataDir, ".roll-agent-profile-decorated"), "utf-8"),
      /"name":"boss-a"/,
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
