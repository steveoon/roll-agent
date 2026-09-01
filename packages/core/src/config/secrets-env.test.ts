import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSecretsEnvPath,
  inspectSecretsFilePermission,
  loadSecretsEnv,
  parseSecretsEnvText,
} from "./secrets-env.ts";

test("parseSecretsEnvText parses KEY=VALUE, ignores comments and blanks", () => {
  const parsed = parseSecretsEnvText(
    ["# comment", "", "FOO=bar", 'QUOTED="hello world"', "SINGLE='value with ${NOT_EXPANDED}'", "WITH_EQUALS=a=b=c"].join("\n"),
  );
  assert.deepEqual(parsed, {
    FOO: "bar",
    QUOTED: "hello world",
    SINGLE: "value with ${NOT_EXPANDED}",
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
