import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { buildInstallBootstrap } from "./build-bootstrap.mjs";

test("bootstrap executes as a detached single file without node_modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll detached bootstrap "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "install.cjs");
  await buildInstallBootstrap(path);
  const source = await readFile(path, "utf8");
  assert.ok(source.length > 0);
  const require = createRequire(new URL("../../packages/core/package.json", import.meta.url));
  const zodManifestPath = require.resolve("zod/package.json");
  const zodManifest = JSON.parse(await readFile(zodManifestPath, "utf8"));
  const zodLicense = await readFile(join(dirname(zodManifestPath), "LICENSE"), "utf8");
  assert.ok(source.includes(`zod@${zodManifest.version}\n${zodLicense}`));
  assert.doesNotMatch(source, /undefined@undefined/);
  const result = spawnSync(process.execPath, [path], {
    cwd: root,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing installer request file/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
});
