import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assetFilename, createManifest, PLATFORMS, writeManifest } from "./metadata.mjs";
import { assertNoLinks, materializePackage, createCoreSelfReference } from "./build.mjs";

test("materialized siblings share modules while nested versions and peer contexts keep their identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-sibling-resolution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  async function pkg(path, name, version, dependencies, code) {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name, version, main: "index.cjs", dependencies }),
    );
    await writeFile(join(path, "index.cjs"), code);
  }
  await pkg(source, "root", "1", { a: "1", b: "1", c: "1", shared: "1" }, "");
  const modules = join(source, "node_modules");
  await pkg(join(modules, "shared"), "shared", "1", {}, "module.exports={tag:'root'};");
  await pkg(
    join(modules, "a"),
    "a",
    "1",
    { b: "1", shared: "1" },
    "exports.shared=require('shared'); exports.b=()=>require('b');",
  );
  await pkg(
    join(modules, "b"),
    "b",
    "1",
    { a: "1", shared: "2" },
    "exports.shared=require('shared'); exports.a=()=>require('a');",
  );
  await pkg(
    join(modules, "b/node_modules/shared"),
    "shared",
    "2",
    {},
    "module.exports={tag:'nested-v2'};",
  );
  await pkg(join(modules, "c"), "c", "1", { shared: "1" }, "module.exports=require('shared');");
  // Same name and version, different physical source: represents a separate pnpm peer context.
  await pkg(
    join(modules, "c/node_modules/shared"),
    "shared",
    "1",
    {},
    "module.exports={tag:'peer-context'};",
  );
  const output = join(root, "output");
  await materializePackage(source, output);
  const require = createRequire(join(output, "index.cjs"));
  const a = require("a");
  const b = require("b");
  assert.equal(a.b(), b);
  assert.equal(b.a(), a);
  assert.equal(a.shared, require("shared"));
  assert.equal(b.shared.tag, "nested-v2");
  assert.equal(require("c").tag, "peer-context");
  assert.notEqual(require("c"), a.shared);
  await assert.rejects(access(join(output, "node_modules/a/node_modules/shared")));
  await assert.rejects(access(join(output, "node_modules/a/node_modules/b")));
  await assertNoLinks(output);
});

test("six-platform manifest requires all nonempty assets and refuses altered retries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(createManifest(root, "1.2.3"));
  for (const platform of PLATFORMS) {
    await writeFile(join(root, assetFilename("1.2.3", platform)), platform);
  }
  const manifest = await writeManifest(root, "1.2.3");
  assert.equal(manifest.assets.length, 6);
  assert.equal(
    await readFile(join(root, "linux-x64.txt"), "utf8"),
    `1.2.3\t${manifest.assets[2].sha256}\t9\troll-1.2.3-linux-x64.tar.gz\n`,
  );
  await writeManifest(root, "1.2.3");
  await writeFile(join(root, assetFilename("1.2.3", "linux-x64")), "tampered");
  await assert.rejects(writeManifest(root, "1.2.3"), /Immutable manifest/);
  assert.throws(() => assetFilename("../../etc", "linux-x64"));
  assert.throws(() => assetFilename("1.2.3", "linux-musl-x64"));
});

test("materialization rewrites workspace exports, preserves nested versions and dependency cycles without links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-materialize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const dep = join(source, "node_modules/a");
  await mkdir(join(dep, "node_modules"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "@roll-agent/core",
      type: "module",
      exports: "./src.ts",
      publishConfig: { exports: "./dist.js" },
      dependencies: { a: "1" },
    }),
  );
  await writeFile(
    join(dep, "package.json"),
    JSON.stringify({ name: "a", dependencies: { "@roll-agent/core": "1" } }),
  );
  await mkdir(join(dep, "node_modules/@roll-agent"));
  await symlink(
    source,
    join(dep, "node_modules/@roll-agent/core"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const output = join(root, "output");
  await materializePackage(source, output);
  await writeFile(join(output, "dist.js"), "export const identity = {}; export default identity;");
  await createCoreSelfReference(output);
  const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
  assert.equal(manifest.exports, "./dist.js");
  assert.equal(manifest.rollDistribution.channel, "standalone");
  const original = await import(pathToFileURL(join(output, "dist.js")).href);
  const facade = await import(
    pathToFileURL(join(output, "node_modules/@roll-agent/core/dist.js")).href
  );
  assert.equal(facade.identity, original.identity);
  assert.equal(facade.default, original.default);
  await assertNoLinks(output);
});
