import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assetFilename, PLATFORMS, sha256, writeManifest } from "./metadata.mjs";

test(
  "upload and finalization use the configured root and require a provisioned marker",
  { skip: process.platform !== "linux" },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "roll-transport-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, "target");
    const assets = join(home, "assets");
    const bin = join(home, "bin");
    await mkdir(join(root, "staging"), { recursive: true });
    await mkdir(join(root, "releases"));
    await mkdir(assets);
    await mkdir(bin);
    for (const platform of PLATFORMS) {
      await writeFile(join(assets, assetFilename("1.2.3", platform)), platform);
    }
    await writeManifest(assets, "1.2.3");
    await writeFile(join(assets, "install.sh"), "#!/bin/sh\n");
    await writeFile(join(assets, "install.ps1"), "# fixture\n");
    const checksums = [];
    for (const name of (await readdir(assets)).sort()) {
      checksums.push(`${await sha256(join(assets, name))}  ${name}\n`);
    }
    await writeFile(join(assets, "CHECKSUMS.sha256"), checksums.join(""));
    // Emulate only transport, then execute the real remote commands/finalizer in this fixture.
    await writeFile(
      join(bin, "ssh"),
      '#!/bin/sh\nfor command do :; done\nexec sh -c "$command"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "scp"),
      '#!/bin/sh\nset -eu\nfor target do :; done\ntarget=$(echo "$target" | cut -d: -f2-)\nfor source do\n case "$source" in "$TEST_ASSETS"/*) cp "$source" "$target";; esac\ndone\n',
      { mode: 0o755 },
    );
    const run = () =>
      spawnSync("bash", [join(import.meta.dirname, "upload.sh"), assets], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_ASSETS: assets,
          ROLL_DIST_ROOT: root,
          ROLL_DIST_SSH_HOST: "example.invalid",
          ROLL_DIST_SSH_USER: "fixture",
          ROLL_DIST_SSH_PORT: "2222",
          ROLL_DIST_SSH_KEY: "fixture",
          ROLL_DIST_SSH_KNOWN_HOSTS: "fixture",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
        },
      });
    assert.notEqual(run().status, 0);
    assert.deepEqual(await readdir(join(root, "staging")), []);
    await writeFile(join(root, ".roll-distribution-root"), "roll-distribution-v1\n");
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readlink(join(root, "releases/stable")), "1.2.3");
    assert.equal(
      (await readFile(join(root, "releases/stable/linux-x64.txt"), "utf8")).split("\t")[0],
      "1.2.3",
    );
    assert.deepEqual(await readdir(join(root, "staging")), []);
  },
);

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
      ROLL_DIST_ROOT: "/srv/example-distribution",
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
    for (const port of ["22", "2222", "00022"]) {
      const result = spawnSync("bash", [join(import.meta.dirname, "upload.sh"), root], {
        env: { ...env, ROLL_DIST_SSH_PORT: port },
        encoding: "utf8",
      });
      assert.equal(result.status, 91);
      assert.equal(await readFile(marker, "utf8"), "called");
      await rm(marker);
    }
    for (const path of [
      "/",
      "/tmp",
      "relative/path",
      "/tmp/../etc",
      "/tmp//root",
      "/tmp/root/",
      "/tmp/root;touch",
      "/tmp/root name",
      "/tmp/root'quoted",
      "/tmp/$HOME",
    ]) {
      const result = spawnSync("bash", [join(import.meta.dirname, "upload.sh"), root], {
        env: { ...env, ROLL_DIST_SSH_PORT: "22", ROLL_DIST_ROOT: path },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid ROLL_DIST_ROOT/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const finalize = spawnSync(
        "sh",
        [join(import.meta.dirname, "finalize.sh"), "1.2.3", "fixture", path],
        { encoding: "utf8" },
      );
      assert.notEqual(finalize.status, 0);
      assert.match(finalize.stderr, /Invalid ROLL_DIST_ROOT/);
    }
  },
);
