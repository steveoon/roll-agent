import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("doctor after global flags diagnoses a broken distribution while other commands fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-broken-doctor-"));
  try {
    const core = resolve(import.meta.dirname, "../..");
    const app = join(root, "app");
    const home = join(root, "home");
    await mkdir(home);
    await writeFile(join(home, "roll.config.yaml"), "{}\n");
    await cp(join(core, "src"), join(app, "src"), {
      recursive: true,
      filter: (path) => !/\.(test|e2e)\.ts$/.test(path),
    });
    await symlink(
      join(core, "node_modules"),
      join(app, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "@roll-agent/core",
        version: "1.0.0",
        type: "module",
        rollDistribution: { schemaVersion: 1, channel: "standalone" },
      }),
    );
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--experimental-sqlite",
          join(app, "src/cli/index.ts"),
          ...args,
        ],
        {
          cwd: home,
          env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    const doctor = run(["--verbose", "doctor", "--json"]);
    assert.equal(doctor.status, 1, doctor.stderr);
    const output: unknown = JSON.parse(doctor.stdout);
    assert.ok(Array.isArray(output));
    assert.ok(
      output.some(
        (check: { name: string; status: string }) =>
          check.name === "Roll 安装与执行环境" && check.status === "fail",
      ),
    );
    const other = run(["--verbose", "agent", "list"]);
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /distribution\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
