import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assetFilename, PLATFORMS, sha256, writeManifest } from "./metadata.mjs";

test("archive output is deterministic and contains no links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await mkdir(join(source, "nested"));
  await writeFile(join(source, "nested/hello.txt"), "hello");
  for (const fast of [false, true]) {
    for (const extension of ["zip", "tar.gz"]) {
      const files = [
        join(root, `one-${fast}.${extension}`),
        join(root, `two-${fast}.${extension}`),
      ];
      for (const path of files) {
        const result = spawnSync(
          process.platform === "win32" ? "python" : "python3",
          [join(import.meta.dirname, "archive.py"), source, path, ...(fast ? ["--fast"] : [])],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(await sha256(files[0]), await sha256(files[1]));
      const names = spawnSync(
        process.platform === "win32" ? "python" : "python3",
        [
          "-c",
          extension === "zip"
            ? 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==["nested/hello.txt"]; assert z.read("nested/hello.txt")==b"hello"'
            : 'import sys,tarfile; t=tarfile.open(sys.argv[1]); assert t.getnames()==["nested/hello.txt"]; assert all(m.isfile() for m in t.getmembers()); assert t.extractfile("nested/hello.txt").read()==b"hello"',
          files[0],
        ],
        { encoding: "utf8" },
      );
      assert.equal(names.status, 0, names.stderr);
    }
  }
});

test(
  "server finalization verifies all assets, preserves immutable versions and rejects downgrade",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "roll-finalize-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "staging"));
    await mkdir(join(root, "releases"));
    await writeFile(join(root, ".roll-distribution-root"), "roll-distribution-v1\n");
    const scriptPath = join(import.meta.dirname, "finalize.sh");
    async function stage(version, id) {
      const directory = join(root, "staging", id);
      await mkdir(directory);
      for (const platform of PLATFORMS) {
        await writeFile(join(directory, assetFilename(version, platform)), platform);
      }
      await writeManifest(directory, version);
      await writeFile(join(directory, "install.sh"), "#!/bin/sh\n");
      await writeFile(join(directory, "install.ps1"), "# installer\n");
      const rows = [];
      for (const name of (await readdir(directory)).sort()) {
        rows.push(`${await sha256(join(directory, name))}  ${name}\n`);
      }
      await writeFile(join(directory, "CHECKSUMS.sha256"), rows.join(""));
      return directory;
    }
    function finalize(version, id) {
      return spawnSync("sh", [scriptPath, version, id, root], { encoding: "utf8" });
    }
    await stage("1.2.3", "first");
    const first = finalize("1.2.3", "first");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(await readlink(join(root, "releases/stable")), "1.2.3");
    await cp(join(root, "releases/1.2.3"), join(root, "staging/retry"), { recursive: true });
    assert.equal(finalize("1.2.3", "retry").status, 0);
    await assert.rejects(readdir(join(root, "staging/retry")), { code: "ENOENT" });
    const corrupt = await stage("1.2.4", "corrupt");
    await writeFile(join(corrupt, assetFilename("1.2.4", "linux-x64")), "broken");
    assert.notEqual(finalize("1.2.4", "corrupt").status, 0);
    assert.ok((await readdir(corrupt)).length > 0);
    assert.equal(await readlink(join(root, "releases/stable")), "1.2.3");
    await stage("1.2.2", "old");
    assert.notEqual(finalize("1.2.2", "old").status, 0);
    assert.equal(await readlink(join(root, "releases/stable")), "1.2.3");
  },
);
