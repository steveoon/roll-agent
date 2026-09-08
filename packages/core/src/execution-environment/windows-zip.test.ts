import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { extractWindowsZip, validateWindowsZip } from "./windows-zip.ts";

type FixtureEntry = {
  name: string;
  content?: string;
  attributes?: number;
  flags?: number;
  size?: number;
  crc?: number;
  deflate?: boolean;
};

function zip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.content ?? "");
    const compressed = entry.deflate ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0x800, 6);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(entry.crc ?? crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.size ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x314, 4);
    header.copy(record, 6, 4, 28);
    record.writeUInt32LE(entry.attributes ?? 0, 38);
    record.writeUInt32LE(offset, 42);
    locals.push(header, name, compressed);
    central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, entries: FixtureEntry[]) {
  const root = await mkdtemp(join(tmpdir(), "roll-windows-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, "archive.zip");
  await writeFile(archive, zip(entries));
  return { root, archive, destination: join(root, "extracted") };
}

test("complete archive extracts Unicode and deep Windows paths without host tools", async (t) => {
  const name = `${"node_modules/dependency/".repeat(16)}中文 space's/file.js`;
  const { archive, destination } = await fixture(t, [
    { name: "app/" },
    { name: "app/plain.txt", content: "plain" },
    { name: `app/${name}`, content: "compressed content", deflate: true },
  ]);
  await validateWindowsZip(archive);
  await extractWindowsZip(archive, destination);
  assert.equal(await readFile(join(destination, `app/${name}`), "utf8"), "compressed content");
});

for (const name of [
  "../escape",
  "/absolute",
  "C:/drive",
  "//server/share",
  "app\\escape",
  "app/../escape",
  "app/CON",
  "app/NUL.txt",
  "app/com1.js",
  "app/LPT³",
  "app/trailing.",
  "app/trailing ",
  "app/a:b",
  "app/a?b",
  "app/a\u0001b",
  "app/a\u007fb",
  "app//empty",
  `app/${"a".repeat(256)}`,
]) {
  test(`rejects unsafe Windows path ${JSON.stringify(name)} before writing files`, async (t) => {
    const { archive, destination } = await fixture(t, [
      { name: "app/good", content: "good" },
      { name },
    ]);
    await mkdir(destination);
    await assert.rejects(extractWindowsZip(archive, destination));
    assert.deepEqual(await readdir(destination), []);
  });
}

for (const entries of [
  [{ name: "app/a" }, { name: "app/a" }],
  [{ name: "app/a" }, { name: "APP/b" }],
  [{ name: "app/a" }, { name: "app/A" }],
  [{ name: "app/a" }, { name: "app" }],
  [{ name: "app" }, { name: "app/a" }],
  [{ name: "app/" }, { name: "app/" }],
  [{ name: "app/link", attributes: (0o120777 << 16) >>> 0 }],
  [{ name: "app/fifo", attributes: (0o010600 << 16) >>> 0 }],
  [{ name: "app/reparse", attributes: 0x400 }],
  [{ name: "app/encrypted", flags: 1 }],
  [{ name: "app/huge", size: 1024 ** 3 + 1, deflate: true }],
  Array.from({ length: 5 }, (_, i) => ({ name: `app/huge-${i}`, size: 1024 ** 3, deflate: true })),
]) {
  test(`rejects archive metadata ${JSON.stringify(entries)}`, async (t) => {
    const { archive, destination } = await fixture(t, entries);
    await assert.rejects(extractWindowsZip(archive, destination));
  });
}

test("CRC, actual length and truncated archive failures are reported", async (t) => {
  for (const entry of [
    { name: "app/crc", content: "data", crc: 123 },
    { name: "app/length", content: "data", size: 10, deflate: true },
  ]) {
    const { archive, destination } = await fixture(t, [entry]);
    await assert.rejects(validateWindowsZip(archive));
    await assert.rejects(extractWindowsZip(archive, destination));
  }
  const { archive } = await fixture(t, [{ name: "app/valid" }]);
  await writeFile(archive, (await readFile(archive)).subarray(0, -10));
  await assert.rejects(validateWindowsZip(archive));
});

test("aborted work does not create destination and releases archive handles", async (t) => {
  const { archive, destination } = await fixture(t, [{ name: "app/a", content: "data" }]);
  await assert.rejects(extractWindowsZip(archive, destination, AbortSignal.abort()), /abort/i);
  await rm(archive);
});

test("existing destination contents and symlink destinations cannot be overwritten", async (t) => {
  const { root, archive, destination } = await fixture(t, [{ name: "app/a", content: "new" }]);
  await mkdir(destination);
  await writeFile(join(destination, "a"), "old");
  await assert.rejects(extractWindowsZip(archive, destination));
  assert.equal(await readFile(join(destination, "a"), "utf8"), "old");
  const link = join(root, "link");
  await symlink(destination, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(extractWindowsZip(archive, link));
});

test("ZIP64 entry counts above the limit fail before reading entries", async (t) => {
  const { archive } = await fixture(t, []);
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(100_001n, 24);
  zip64.writeBigUInt64LE(100_001n, 32);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.from(zip([]));
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  await writeFile(archive, Buffer.concat([zip64, locator, end]));
  await assert.rejects(validateWindowsZip(archive), /too many entries/);
});

test("cancellation during extraction closes handles before scratch can be removed", async (t) => {
  const { archive, destination } = await fixture(t, [
    { name: "app/large", content: "data".repeat(8 * 1024 * 1024), deflate: true },
  ]);
  await mkdir(destination);
  const controller = new AbortController();
  const watcher = setInterval(() => {
    lstat(join(destination, "app/large")).then(
      () => controller.abort(),
      () => {},
    );
  }, 1);
  try {
    await assert.rejects(extractWindowsZip(archive, destination, controller.signal), /abort/i);
    assert.equal(controller.signal.aborted, true);
  } finally {
    clearInterval(watcher);
  }
  await rm(archive);
  await rm(destination, { recursive: true });
});

for (const name of [
  "unexpected",
  "unexpected/file",
  "distribution.json/",
  "distribution.json/file",
  "app",
  "runtime",
  "App/file",
]) {
  test(`rejects unexpected distribution root ${JSON.stringify(name)} before extracting`, async (t) => {
    const { archive, destination } = await fixture(t, [
      { name: "app/valid", content: "valid" },
      { name },
    ]);
    await mkdir(destination);
    await assert.rejects(validateWindowsZip(archive), /distribution root/);
    await assert.rejects(extractWindowsZip(archive, destination), /distribution root/);
    assert.deepEqual(await readdir(destination), []);
  });
}

test("allows only the distribution metadata file and app/runtime directory trees", async (t) => {
  const { archive, destination } = await fixture(t, [
    { name: "distribution.json", content: "{}" },
    { name: "runtime/" },
    { name: "runtime/node.exe", content: "node" },
    { name: "app/bin/roll.js", content: "roll" },
  ]);
  await extractWindowsZip(archive, destination);
  assert.equal(await readFile(join(destination, "distribution.json"), "utf8"), "{}");
});

test("existing linked destination subtree cannot redirect archive writes outside staging", async (t) => {
  const { root, archive, destination } = await fixture(t, [{ name: "app/file", content: "new" }]);
  const outside = join(root, "outside");
  await mkdir(outside);
  await mkdir(destination);
  await symlink(
    outside,
    join(destination, "app"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(extractWindowsZip(archive, destination), /empty directory/);
  assert.deepEqual(await readdir(outside), []);
});
