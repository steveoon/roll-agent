import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { openPromise } from "yauzl";
import type { Entry, ZipFile } from "yauzl";

const MAX_ENTRIES = 100_000;
const MAX_FILE_BYTES = 1024 ** 3;
const MAX_TOTAL_BYTES = 4 * 1024 ** 3;

function fsPath(path: string): string {
  return toNamespacedPath(resolve(path));
}

function invalid(detail: string): Error {
  return new Error(`Unsafe Windows distribution ZIP: ${detail}`);
}

type CheckedEntry = { entry: Entry; name: string; directory: boolean };
type PathIdentity = { name: string; directory: boolean; explicit: boolean };

function checkEntry(entry: Entry): CheckedEntry {
  const name = entry.fileName;
  const directory = name.endsWith("/");
  const components = (directory ? name.slice(0, -1) : name).split("/");
  for (const component of components) {
    if (
      component.length === 0 ||
      component.length > 255 ||
      component === "." ||
      component === ".." ||
      Array.from(component).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /[<>:"\\|?*]/u.test(component) ||
      /[. ]$/u.test(component) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(component)
    ) {
      throw invalid(`invalid path ${JSON.stringify(name)}`);
    }
  }
  const root = components[0];
  if (
    root === "distribution.json"
      ? directory || components.length !== 1
      : (root !== "app" && root !== "runtime") || (!directory && components.length === 1)
  ) {
    throw invalid(`unexpected distribution root ${JSON.stringify(name)}`);
  }
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x40) !== 0) {
    throw invalid(`encrypted entry ${JSON.stringify(name)}`);
  }
  if (!entry.canDecodeFileData()) {
    throw invalid(`unsupported compression for ${JSON.stringify(name)}`);
  }
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  const attributes = entry.externalFileAttributes & 0xffff;
  if (
    (attributes & 0x400) !== 0 ||
    (mode !== 0 && mode !== (directory ? 0o040000 : 0o100000)) ||
    (!directory && (attributes & 0x10) !== 0)
  ) {
    throw invalid(`link, reparse point or special file ${JSON.stringify(name)}`);
  }
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > MAX_FILE_BYTES ||
    (directory && entry.uncompressedSize !== 0)
  ) {
    throw invalid(`invalid or excessive expanded size for ${JSON.stringify(name)}`);
  }
  return { entry, name: directory ? name.slice(0, -1) : name, directory };
}

/** Preflight the entire central directory before creating any output paths. */
async function collectEntries(zip: ZipFile, signal?: AbortSignal): Promise<CheckedEntry[]> {
  if (zip.entryCount > MAX_ENTRIES) throw invalid("too many entries");
  const entries: CheckedEntry[] = [];
  const paths = new Map<string, PathIdentity>();
  let totalBytes = 0;
  for await (const entry of zip.eachEntry()) {
    signal?.throwIfAborted();
    if (entries.length >= MAX_ENTRIES) throw invalid("too many entries");
    const checked = checkEntry(entry);
    totalBytes += entry.uncompressedSize;
    if (totalBytes > MAX_TOTAL_BYTES) throw invalid("expanded archive exceeds 4 GiB");
    const components = checked.name.split("/");
    for (let i = 0; i < components.length; i++) {
      const name = components.slice(0, i + 1).join("/");
      const key = name.toUpperCase();
      const explicit = i === components.length - 1;
      const directory = !explicit || checked.directory;
      const previous = paths.get(key);
      if (previous) {
        if (
          previous.name !== name ||
          previous.directory !== directory ||
          (previous.explicit && explicit)
        ) {
          throw invalid(
            `duplicate, case collision or file/directory conflict at ${JSON.stringify(name)}`,
          );
        }
        if (explicit) previous.explicit = true;
      } else {
        paths.set(key, { name, directory, explicit });
      }
    }
    entries.push(checked);
  }
  return entries;
}

async function consumeEntry(
  zip: ZipFile,
  checked: CheckedEntry,
  destination: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { entry, name, directory } = checked;
  // A central/local mismatch must not hide a second filename or encryption flag.
  const local = await zip.readLocalFileHeaderPromise(entry);
  if (
    !local.fileName.equals(entry.fileNameRaw) ||
    local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
    local.compressionMethod !== entry.compressionMethod
  ) {
    throw invalid(`local header disagrees with directory for ${JSON.stringify(name)}`);
  }
  let length = 0;
  let checksum = 0;
  const integrity = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      if (length > entry.uncompressedSize || length > MAX_FILE_BYTES) {
        callback(invalid(`expanded size mismatch for ${JSON.stringify(name)}`));
        return;
      }
      checksum = crc32(chunk, checksum);
      callback(null, chunk);
    },
    flush(callback) {
      if (length !== entry.uncompressedSize || checksum !== entry.crc32) {
        callback(invalid(`CRC or expanded size mismatch for ${JSON.stringify(name)}`));
        return;
      }
      callback();
    },
  });
  const target = destination && !directory ? fsPath(join(destination, name)) : undefined;
  if (target) await mkdir(dirname(target), { recursive: true });
  // Acquire the read stream before opening output so a corrupt local header
  // cannot leave a pending file open. pipeline waits for both streams to close.
  const input = await zip.openReadStreamPromise(entry);
  const output = target
    ? createWriteStream(target, { flags: "wx", mode: 0o600 })
    : new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
  await pipeline(input, integrity, output, { signal });
  if (destination && directory) await mkdir(fsPath(join(destination, name)), { recursive: true });
}

async function inspectOrExtract(
  archive: string,
  destination: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const zip = await openPromise(fsPath(archive), {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  // Register immediately, including while processing entry contents, to avoid
  // unhandled fd errors and await the actual close before callers clean scratch.
  const closed = new Promise<void>((resolve, reject) => {
    zip.once("close", resolve);
    zip.on("error", (error: Error) => {
      if (!zip.isOpen) reject(error);
    });
  });
  // Metadata errors also reject collectEntries; this handler prevents an
  // unhandled rejection until the final close is awaited.
  closed.catch(() => {});
  try {
    const entries = await collectEntries(zip, signal);
    signal?.throwIfAborted();
    if (destination) {
      const target = fsPath(destination);
      try {
        const stat = await lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(target)).length !== 0) {
          throw invalid("extraction destination must be an empty directory");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await mkdir(target, { recursive: true });
      }
    }
    for (const entry of entries) await consumeEntry(zip, entry, destination, signal);
  } finally {
    zip.close();
    await closed;
  }
}

/** Validate names, metadata, limits, expanded sizes and CRC without writing files. */
export async function validateWindowsZip(archive: string, signal?: AbortSignal): Promise<void> {
  await inspectOrExtract(archive, undefined, signal);
}

/** Extract a preflighted ZIP using Node's long-path-aware filesystem APIs. */
export async function extractWindowsZip(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await inspectOrExtract(archive, destination, signal);
}
