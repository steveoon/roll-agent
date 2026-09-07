import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Nginx rendering keeps instance configuration private and refuses unsafe roots or overwrites", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roll-nginx-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "site.conf");
  const root = "/srv/example-distribution";
  const run = (path, value = root) =>
    spawnSync(process.execPath, [join(import.meta.dirname, "render-nginx.mjs"), path], {
      env: { ...process.env, ROLL_DIST_ROOT: value },
      encoding: "utf8",
    });
  const result = run(output);
  assert.equal(result.status, 0, result.stderr);
  const template = await readFile(join(import.meta.dirname, "nginx.conf"), "utf8");
  assert.equal(await readFile(output, "utf8"), template.replaceAll("__ROLL_DIST_ROOT__", root));
  assert.equal(result.stdout.includes(root), false);
  if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.notEqual(run(output).status, 0);
  const inRepo = join(import.meta.dirname, `.private-render-${randomUUID()}.conf`);
  assert.match(run(inRepo).stderr, /outside the repository/);
  await assert.rejects(access(inRepo));
  const alias = join(directory, "checkout-link");
  await symlink(import.meta.dirname, alias, process.platform === "win32" ? "junction" : "dir");
  assert.match(run(join(alias, "private.conf")).stderr, /outside the repository/);
  const otherCheckout = join(directory, "another-checkout");
  await mkdir(join(otherCheckout, ".git"), { recursive: true });
  assert.match(run(join(otherCheckout, "private.conf")).stderr, /outside the repository/);
  for (const invalid of [
    "",
    "/",
    "/tmp",
    "/tmp/../root",
    "/tmp//root",
    "/tmp/.hidden",
    "/tmp/a b",
    "/tmp/$HOME",
    "/tmp/root;",
  ]) {
    assert.match(run(join(directory, "invalid.conf"), invalid).stderr, /Invalid ROLL_DIST_ROOT/);
  }
});
