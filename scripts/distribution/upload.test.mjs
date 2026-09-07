import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test(
  "invalid SSH ports stop before any publication files, credentials or SSH are used",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "roll-upload-port-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    await mkdir(bin);
    const marker = join(root, "cut-was-called");
    await writeFile(join(bin, "cut"), '#!/bin/sh\nprintf called > "$TEST_MARKER"\nexit 91\n', {
      mode: 0o755,
    });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_MARKER: marker,
      ROLL_DIST_SSH_HOST: "example.invalid",
      ROLL_DIST_SSH_USER: "fixture",
      ROLL_DIST_SSH_KEY: "fixture",
      ROLL_DIST_SSH_KNOWN_HOSTS: "fixture",
    };
    for (const port of ["abc", "0", "65536", "99999999999999999999", "-1"]) {
      const result = spawnSync("bash", [join(import.meta.dirname, "upload.sh"), root], {
        env: { ...env, ROLL_DIST_SSH_PORT: port },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid ROLL_DIST_SSH_PORT/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
    for (const port of ["22", "63452", "00022"]) {
      const result = spawnSync("bash", [join(import.meta.dirname, "upload.sh"), root], {
        env: { ...env, ROLL_DIST_SSH_PORT: port },
        encoding: "utf8",
      });
      assert.equal(result.status, 91);
      assert.equal(await readFile(marker, "utf8"), "called");
      await rm(marker);
    }
  },
);
