import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Cross-package contract tests run outside package rootDir boundaries.
test("browser form MCP handoff regression", { timeout: 60000 }, () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "tests/browser-form/handoff.test.mjs"],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 55000 },
  );
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
});
