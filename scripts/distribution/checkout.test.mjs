import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

test("autocrlf checkout preserves frozen protocol fixture bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-checkout-eol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = resolve(import.meta.dirname, "../..");
  const fixture = await readFile(
    join(repo, "packages/relay-protocol/fixtures/v1/valid-device-connect.json"),
  );
  await writeFile(join(root, "fixture.json"), fixture);
  await writeFile(join(root, ".gitattributes"), await readFile(join(repo, ".gitattributes")));
  const git = (args) =>
    execFileSync("git", ["-c", "core.autocrlf=true", ...args], { cwd: root, stdio: "pipe" });
  git(["init", "--quiet"]);
  git(["add", "--", ".gitattributes", "fixture.json"]);
  const output = join(root, "checkout");
  await mkdir(output);
  git(["checkout-index", "--all", `--prefix=${output}${sep}`]);
  assert.deepEqual(await readFile(join(output, "fixture.json")), fixture);
});
