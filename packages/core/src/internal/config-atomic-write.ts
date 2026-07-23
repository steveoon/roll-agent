import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface AtomicTextWriteRequest {
  readonly configPath: string;
  readonly raw: string;
  readonly existed: boolean;
  readonly verifyBeforeRename: () => void;
}

function writeTextAtomic({
  configPath,
  raw,
  existed,
  verifyBeforeRename,
}: AtomicTextWriteRequest): void {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true });
  const fileMode = existed ? statSync(configPath).mode & 0o777 : 0o600;
  const temporaryPath = resolve(
    directory,
    `.${basename(configPath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporaryPath, "wx", fileMode);
    writeFileSync(fileDescriptor, raw, "utf-8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    verifyBeforeRename();
    renameSync(temporaryPath, configPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

export const atomicTextFileWriter = {
  write: writeTextAtomic,
};

function fsyncDirectory(directory: string): void {
  // Windows does not expose a portable directory fsync through Node's fs APIs. The file itself
  // was already fsynced before rename, so do not report failure after replacement succeeded just
  // because FlushFileBuffers rejects a directory handle.
  if (process.platform === "win32") {
    return;
  }

  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = openSync(directory, "r");
    fsyncSync(directoryDescriptor);
  } finally {
    if (directoryDescriptor !== undefined) {
      closeSync(directoryDescriptor);
    }
  }
}
