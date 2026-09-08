import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  mkdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installWindowsDistribution,
  windowsInstallRequestSchema,
} from "./windows-install-bootstrap.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "roll-bootstrap-test-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const archive = join(temporary, "archive.zip");
  const bytes = Buffer.from("invalid zip, valid transport digest");
  await writeFile(archive, bytes);
  return {
    temporary,
    request: {
      schemaVersion: 1 as const,
      installRoot: join(temporary, "Roll 用户's install"),
      archive,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: "0.38.1",
      platform: "win32-arm64" as const,
      resultPath: join(temporary, "result.json"),
    },
  };
}

test("installer rejects corrupt transport before creating the installation", async (t) => {
  const { temporary, request } = await fixture(t);
  await assert.rejects(
    installWindowsDistribution({ ...request, sha256: "0".repeat(64) }),
    /checksum mismatch/,
  );
  assert.deepEqual(await readdir(temporary), ["archive.zip"]);
});

test("installer rejects an invalid ZIP and releases its scratch and owned lock", async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(installWindowsDistribution(request), /central directory|signature|zip/i);
  assert.deepEqual(await readdir(request.installRoot), []);
  // A failed first installation remains retryable without manually deleting the install root.
  await assert.rejects(installWindowsDistribution(request), /central directory|signature|zip/i);
  assert.deepEqual(await readdir(request.installRoot), []);
});

test("installer preserves unknown nonempty directories", async (t) => {
  const { request } = await fixture(t);
  await mkdir(request.installRoot);
  const document = join(request.installRoot, "keep.txt");
  await writeFile(document, "user file");
  await assert.rejects(installWindowsDistribution(request), /not empty/);
  assert.equal(await readFile(document, "utf8"), "user file");
  assert.deepEqual(await readdir(request.installRoot), ["keep.txt"]);
});

test("installer leaves another installer lock intact", async (t) => {
  const { request } = await fixture(t);
  await mkdir(join(request.installRoot, ".install-lock"), { recursive: true });
  await writeFile(
    join(request.installRoot, "installation.json"),
    '{"schemaVersion":1,"channel":"standalone"}',
  );
  await writeFile(join(request.installRoot, ".install-lock/owner.json"), "other owner");
  await assert.rejects(installWindowsDistribution(request), /Another Roll installer/);
  assert.equal(
    await readFile(join(request.installRoot, ".install-lock/owner.json"), "utf8"),
    "other owner",
  );
});

test("installer refuses broken existing metadata or current pointer", async (t) => {
  const { request } = await fixture(t);
  await mkdir(request.installRoot);
  const marker = join(request.installRoot, "installation.json");
  await writeFile(marker, '{"schemaVersion":1,"channel":"standalone"}');
  await assert.rejects(installWindowsDistribution(request), /Invalid installation pointer/);
  assert.deepEqual(await readdir(request.installRoot), ["installation.json"]);
  await writeFile(marker, '{"schemaVersion":1,"channel":"npm"}');
  await assert.rejects(installWindowsDistribution(request));
  assert.deepEqual(await readdir(request.installRoot), ["installation.json"]);
});

test("installer refuses a symlink or junction install root", async (t) => {
  const { temporary, request } = await fixture(t);
  const outside = join(temporary, "outside");
  await mkdir(outside);
  await symlink(outside, request.installRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installWindowsDistribution(request), /reparse point/);
  assert.deepEqual(await readdir(outside), []);
});

test("cancelled installer never begins download validation or creates the root", async (t) => {
  const { temporary, request } = await fixture(t);
  await assert.rejects(
    installWindowsDistribution(request, { signal: AbortSignal.abort(new Error("cancelled")) }),
    /cancelled/,
  );
  assert.deepEqual(await readdir(temporary), ["archive.zip"]);
});

test("bootstrap contract rejects version traversal, relative roots and oversized archives", async (t) => {
  const { request } = await fixture(t);
  for (const change of [
    { version: "../other" },
    { installRoot: "relative" },
    { size: 1024 ** 3 + 1 },
    { schemaVersion: 2 },
  ]) {
    assert.equal(windowsInstallRequestSchema.safeParse({ ...request, ...change }).success, false);
  }
});
