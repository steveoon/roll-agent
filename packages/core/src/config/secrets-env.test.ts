import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSecretsEnvPath,
  inspectSecretsFilePermission,
  loadSecretsEnv,
  parseSecretsEnvText,
  readSecretsEnvVariables,
} from "./secrets-env.ts";

test("parseSecretsEnvText parses KEY=VALUE, ignores comments and blanks", () => {
  const parsed = parseSecretsEnvText(
    [
      "# comment",
      "",
      "FOO=bar",
      'QUOTED="hello world"',
      `SINGLE='value with \${NOT_EXPANDED}'`,
      "WITH_EQUALS=a=b=c",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    FOO: "bar",
    QUOTED: "hello world",
    SINGLE: `value with \${NOT_EXPANDED}`,
    WITH_EQUALS: "a=b=c",
  });
});

test("parseSecretsEnvText skips malformed lines without throwing", () => {
  assert.deepEqual(parseSecretsEnvText("=nokey\nNOVALUE\nOK=1"), { OK: "1" });
});

test("defaultSecretsEnvPath joins home with .roll-agent/secrets.env", () => {
  assert.equal(defaultSecretsEnvPath("/home/u"), join("/home/u", ".roll-agent", "secrets.env"));
});

test("loadSecretsEnv returns undefined when the file does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-secrets-"));
  assert.equal(loadSecretsEnv(join(dir, "secrets.env")), undefined);
});

test("inspectSecretsFilePermission does not judge mode bits on win32", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-secrets-"));
  const path = join(dir, "secrets.env");
  writeFileSync(path, "FOO=bar\n");
  chmodSync(path, 0o644);
  assert.deepEqual(inspectSecretsFilePermission(path, "win32"), {
    exists: true,
    isPrivate: undefined,
  });
});

test("inspectSecretsFilePermission distinguishes a stat error from a missing file", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("目录权限不能在 win32 / root 下稳定模拟");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "roll-secrets-"));
  const lockedDir = join(dir, "locked");
  mkdirSync(lockedDir);
  const path = join(lockedDir, "secrets.env");
  writeFileSync(path, "FOO=bar\n");
  chmodSync(lockedDir, 0o000);
  try {
    const permission = inspectSecretsFilePermission(path);
    assert.equal(permission.exists, false);
    assert.equal(permission.isPrivate, undefined);
    assert.match(permission.error ?? "", /EACCES|permission denied/iu);
  } finally {
    chmodSync(lockedDir, 0o700);
  }
});

test("readSecretsEnvVariables treats a missing file as readable and empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-secrets-"));
  assert.deepEqual(readSecretsEnvVariables(join(dir, "secrets.env")), {
    variables: {},
    readable: true,
  });
});

test("readSecretsEnvVariables loads variables from a readable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-secrets-"));
  const path = join(dir, "secrets.env");
  writeFileSync(path, "FOO=bar\n");
  assert.deepEqual(readSecretsEnvVariables(path), {
    variables: { FOO: "bar" },
    readable: true,
  });
});

test("readSecretsEnvVariables reports an unreadable file without throwing", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("chmod 000 不能在 win32 / root 下模拟不可读");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "roll-secrets-"));
  const path = join(dir, "secrets.env");
  writeFileSync(path, "FOO=bar\n");
  chmodSync(path, 0o000);
  assert.deepEqual(readSecretsEnvVariables(path), { variables: {}, readable: false });
  chmodSync(path, 0o600);
});

test("loadSecretsEnv loads variables and inspectSecretsFilePermission flags 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-secrets-"));
  const path = join(dir, "secrets.env");
  writeFileSync(path, "FOO=bar\n");
  chmodSync(path, 0o600);
  const loaded = loadSecretsEnv(path);
  assert.deepEqual(loaded?.variables, { FOO: "bar" });
  assert.deepEqual(inspectSecretsFilePermission(path), { exists: true, isPrivate: true });
  chmodSync(path, 0o644);
  assert.deepEqual(inspectSecretsFilePermission(path), { exists: true, isPrivate: false });
});
