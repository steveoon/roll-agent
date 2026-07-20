import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinWorkdirRoot } from "./workdir.ts";

test("只有现存且 canonical 路径受 root 包含的 workdir 才通过", (context) => {
  const fixture = mkdtempSync(join(tmpdir(), "roll-workdir-existing-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, "repo");
  const child = join(root, "subdir");
  const sibling = join(fixture, "repo-sibling");
  const dotdotName = join(root, "..cache");
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling);
  mkdirSync(dotdotName);

  assert.equal(isWithinWorkdirRoot(root, root), true);
  assert.equal(isWithinWorkdirRoot(root, child), true);
  assert.equal(isWithinWorkdirRoot(root, join(root, "../repo-sibling")), false);
  assert.equal(isWithinWorkdirRoot(root, sibling), false);
  assert.equal(isWithinWorkdirRoot(root, dotdotName), true);
  assert.equal(isWithinWorkdirRoot(root, join(root, "future")), false);
});

test(
  "root 内指向 root 外的现存 symlink workdir 不通过 canonical containment",
  { skip: process.platform === "win32" },
  (context) => {
    const fixture = mkdtempSync(join(tmpdir(), "roll-workdir-boundary-"));
    context.after(() => rmSync(fixture, { recursive: true, force: true }));
    const root = join(fixture, "root");
    const outside = join(fixture, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync("../outside", join(root, "linked-workdir"));

    assert.equal(isWithinWorkdirRoot(root, join(root, "linked-workdir")), false);
  },
);
