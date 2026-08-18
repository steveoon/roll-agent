import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const OUTPUT_DUMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const OUTPUT_DUMP_MAX_FILES = 32;
export const OUTPUT_DUMP_SESSION_CAP_BYTES = 4 * 1_048_576;

const DUMP_DIR_NAME = join(".roll-agent", "bash-output-dumps");

export function rollOutputDumpDir(base: string = homedir()): string {
  return join(base, DUMP_DIR_NAME);
}

export function ensureOutputDumpDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function pruneOutputDumpDir(dir: string, now: number = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const stats = entries
    .map((name) => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { name: string; mtime: number } => entry !== undefined)
    .sort((left, right) => left.mtime - right.mtime);
  for (const entry of stats) {
    if (now - entry.mtime > OUTPUT_DUMP_MAX_AGE_MS) {
      try {
        unlinkSync(join(dir, entry.name));
      } catch {}
    }
  }
  const remaining = stats.filter((entry) => now - entry.mtime <= OUTPUT_DUMP_MAX_AGE_MS);
  const excess = remaining.length - OUTPUT_DUMP_MAX_FILES;
  for (let index = 0; index < excess; index += 1) {
    const oldest = remaining[index];
    if (oldest !== undefined) {
      try {
        unlinkSync(join(dir, oldest.name));
      } catch {}
    }
  }
}

export function allocateOutputDumpFile(dir: string, label: string): string {
  ensureOutputDumpDir(dir);
  pruneOutputDumpDir(dir);
  return join(dir, `${String(Date.now())}-${label}-${randomUUID()}.log`);
}

export function writeOutputDump(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  writeSync(fd, text);
  closeSync(fd);
}

export interface OutputDumpWriter {
  readonly path: string;
  write(text: string): void;
  close(): void;
}

export function createOutputDumpWriter(path: string, capBytes: number): OutputDumpWriter {
  const fd = openSync(path, "w", 0o600);
  let written = 0;
  let closed = false;
  return {
    path,
    write(text) {
      if (closed || written >= capBytes) {
        return;
      }
      const buffer = Buffer.from(text, "utf8");
      const room = capBytes - written;
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
      writeSync(fd, slice);
      written += slice.length;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      closeSync(fd);
    },
  };
}

export function isWithinOutputDumpDir(path: string, dir: string = rollOutputDumpDir()): boolean {
  const resolved = resolve(path);
  const base = resolve(dir);
  return resolved === base || resolved.startsWith(base + sep);
}

export function describeOutputDumpRecovery(path: string): string {
  return `完整输出已落盘: ${path}；用 roll__read_file 以 offset/limit 分页查看被截断的中段，或重跑更窄的命令`;
}
