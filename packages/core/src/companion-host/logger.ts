import { appendFile, chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { watch, type FSWatcher } from "node:fs";

export interface CompanionLogger {
  info(message: string): void;
  error(message: string): void;
}

export class FileCompanionLogger implements CompanionLogger {
  readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  private write(level: "INFO" | "ERROR", message: string): void {
    const safeMessage = message.replaceAll("\r", " ").replaceAll("\n", " ");
    const line = `${new Date().toISOString()} ${level} ${safeMessage}\n`;
    const directory = dirname(this.logPath);
    mkdir(directory, { recursive: true, mode: 0o700 })
      .then(() => chmod(directory, 0o700))
      .then(() => appendFile(this.logPath, line, { encoding: "utf8", mode: 0o600 }))
      .then(() => chmod(this.logPath, 0o600))
      .catch(() => undefined);
  }
}

export async function readCompanionLogs(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

export async function followCompanionLogs(
  logPath: string,
  onText: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(logPath), 0o700);
  const handle = await open(logPath, "a", 0o600);
  await handle.close();
  await chmod(logPath, 0o600);
  let offset = (await stat(logPath)).size;
  let reading = false;
  const stopped = Promise.withResolvers<void>();
  const readTail = async () => {
    if (reading) {
      return;
    }
    reading = true;
    try {
      const content = await readFile(logPath);
      if (content.length < offset) {
        offset = 0;
      }
      if (content.length > offset) {
        onText(content.subarray(offset).toString("utf8"));
        offset = content.length;
      }
    } finally {
      reading = false;
    }
  };
  const watcher: FSWatcher = watch(logPath, () => {
    readTail().catch(() => undefined);
  });
  if (signal.aborted) {
    watcher.close();
    return;
  }
  const stop = () => {
    watcher.close();
    stopped.resolve();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    await stopped.promise;
  } finally {
    signal.removeEventListener("abort", stop);
    watcher.close();
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
