import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Changesets preserves patch propagation and private-package versioning", () => {
  const cwd = mkdtempSync(join(tmpdir(), "roll-changesets-version-"));
  const cli = fileURLToPath(new URL("../node_modules/@changesets/cli/bin.js", import.meta.url));
  const config = JSON.parse(readFileSync(new URL("../.changeset/config.json", import.meta.url)));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
  const writeJson = (path, value) => writeFileSync(join(cwd, path), JSON.stringify(value));
  try {
    for (const dir of [".changeset", "packages/library", "packages/private-agent"]) {
      mkdirSync(join(cwd, dir), { recursive: true });
    }
    writeJson("package.json", { name: "fixture", private: true, packageManager: "pnpm@11.24.0" });
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeJson(".changeset/config.json", {
      ...config,
      changelog: [createRequire(import.meta.url).resolve(config.changelog[0]), config.changelog[1]],
      format: false,
    });
    writeJson("packages/library/package.json", { name: "@fixture/library", version: "1.0.0" });
    writeJson("packages/private-agent/package.json", {
      name: "@fixture/private-agent",
      private: true,
      version: "1.0.0",
      dependencies: { "@fixture/library": "workspace:*" },
    });
    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "."],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      const git = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
      assert.equal(git.status, 0, git.stderr);
    }
    writeFileSync(join(cwd, ".changeset/fix.md"), '---\n"@fixture/library": patch\n---\n\nFix.\n');
    const output = join(cwd, "plan.json");
    const status = run("status", "--output", output);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const plan = JSON.parse(readFileSync(output));
    assert.deepEqual(plan.releases.map(({ name, newVersion }) => [name, newVersion]).sort(), [
      ["@fixture/library", "1.0.1"],
      ["@fixture/private-agent", "1.0.1"],
    ]);
    const version = run("version");
    assert.equal(version.status, 0, version.stdout + version.stderr);
    for (const dir of ["library", "private-agent"]) {
      assert.equal(
        JSON.parse(readFileSync(join(cwd, "packages", dir, "package.json"))).version,
        "1.0.1",
      );
    }
    assert.equal(existsSync(join(cwd, ".changeset/fix.md")), false);
    assert.match(readFileSync(join(cwd, "packages/library/CHANGELOG.md"), "utf8"), /Fix\./u);
    // Release automation calls version only when changesets exist; v3 now rejects a no-op.
    assert.equal(run("version").status, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
