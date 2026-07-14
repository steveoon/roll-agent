import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseDocument } from "yaml";

const CONFIG_REVISION_BRAND: unique symbol = Symbol("ConfigRevision");
const CONFIG_WRITE_LOCK_STALE_MS = 5 * 60_000;

export type ConfigRevision = string & {
  readonly [CONFIG_REVISION_BRAND]: true;
};

export type ConfigPath = readonly (string | number)[];

export type ConfigPatch =
  | {
      readonly op: "set";
      readonly path: ConfigPath;
      readonly value: unknown;
    }
  | {
      readonly op: "delete";
      readonly path: ConfigPath;
    };

export interface ConfigDocumentSnapshot {
  readonly configPath: string;
  readonly existed: boolean;
  readonly raw: string;
  readonly revision: ConfigRevision;
  readonly persisted: Readonly<Record<string, unknown>>;
}

export interface ConfigDocumentPreview extends ConfigDocumentSnapshot {
  readonly previousRaw: string;
  readonly previousRevision: ConfigRevision;
  readonly changed: boolean;
}

export interface ConfigDocumentWriteResult extends ConfigDocumentPreview {
  readonly backupPath?: string;
}

export interface ConfigDocumentRecoveryWriteResult extends ConfigDocumentSnapshot {
  readonly previousRaw: string;
  readonly previousRevision: ConfigRevision;
  readonly changed: boolean;
  readonly backupPath?: string;
}

export class ConfigRevisionConflictError extends Error {
  readonly code = "config_revision_conflict" as const;
  readonly expectedRevision: ConfigRevision;
  readonly actualRevision: ConfigRevision;

  constructor(expectedRevision: ConfigRevision, actualRevision: ConfigRevision) {
    super("配置文件已被其他进程修改，请刷新后重试。");
    this.name = "ConfigRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class ConfigWriteLockError extends Error {
  readonly code = "config_write_locked" as const;

  constructor() {
    super("配置正在由另一个 Roll 进程写入，请稍后刷新并重试。");
    this.name = "ConfigWriteLockError";
  }
}

export class ConfigDocumentParseError extends Error {
  readonly code = "config_document_parse_error" as const;

  constructor(configPath: string, message: string, cause?: Error) {
    super(`Invalid YAML syntax in config file: ${configPath}\n${message}`, {
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "ConfigDocumentParseError";
  }
}

export function createConfigRevision(raw: string): ConfigRevision {
  return createHash("sha256").update(raw).digest("hex") as ConfigRevision;
}

export class YamlConfigDocumentStore {
  readonly configPath: string;
  readonly fallbackRaw: string;

  constructor(configPath: string, fallbackRaw: string) {
    this.configPath = resolve(configPath);
    this.fallbackRaw = fallbackRaw;
  }

  read(): ConfigDocumentSnapshot {
    const existed = existsSync(this.configPath);
    const raw = existed ? readFileSync(this.configPath, "utf-8") : this.fallbackRaw;
    const persisted = parseYamlObject(raw, this.configPath);
    return {
      configPath: this.configPath,
      existed,
      raw,
      revision: createConfigRevision(raw),
      persisted,
    };
  }

  previewPatches(
    patches: readonly ConfigPatch[],
    expectedRevision?: ConfigRevision,
  ): ConfigDocumentPreview {
    const current = this.read();
    assertExpectedRevision(current.revision, expectedRevision);
    return createPreview(current, applyPatchesToYamlText(current.raw, this.configPath, patches));
  }

  previewObject(
    persisted: Readonly<Record<string, unknown>>,
    expectedRevision?: ConfigRevision,
  ): ConfigDocumentPreview {
    const current = this.read();
    assertExpectedRevision(current.revision, expectedRevision);
    const document = parseYamlDocument(current.raw, this.configPath);
    applyObjectDiff(document, current.persisted, persisted, []);
    return createPreview(current, document.toString({ lineWidth: 0 }));
  }

  previewRaw(raw: string, expectedRevision?: ConfigRevision): ConfigDocumentPreview {
    const current = this.read();
    assertExpectedRevision(current.revision, expectedRevision);
    parseYamlObject(raw, this.configPath);
    return createPreview(current, normalizeTrailingNewline(raw));
  }

  commit(
    preview: ConfigDocumentPreview,
    options: { readonly backup?: boolean } = {},
  ): ConfigDocumentWriteResult {
    if (!preview.changed) {
      const current = this.read();
      assertExpectedRevision(current.revision, preview.previousRevision);
      return { ...preview };
    }

    const writablePath = resolveWritablePath(this.configPath);
    const writeLock = acquireConfigWriteLock(writablePath);
    try {
      const current = this.read();
      assertExpectedRevision(current.revision, preview.previousRevision);
      assertWritablePathUnchanged(this.configPath, writablePath, preview.previousRevision);

      const backupPath =
        options.backup !== false && current.existed
          ? writeBackup(writablePath, current.raw)
          : undefined;
      writeTextAtomic(writablePath, preview.raw, current.existed, () => {
        assertConfigDocumentUnchanged(
          this.configPath,
          this.fallbackRaw,
          writablePath,
          current.existed,
          current.revision,
        );
      });

      return {
        ...preview,
        existed: true,
        ...(backupPath !== undefined ? { backupPath } : {}),
      };
    } finally {
      writeLock.release();
    }
  }

  /**
   * Replace an existing, potentially unparseable document after an upper layer has validated the
   * candidate. This intentionally bypasses read()/preview so `roll config init` can recover a
   * malformed file after explicit confirmation; ordinary CLI/UI writes must keep using commit().
   */
  replaceRawForRecovery(
    raw: string,
    expectedRevision: ConfigRevision,
  ): ConfigDocumentRecoveryWriteResult {
    const normalizedRaw = normalizeTrailingNewline(raw);
    const persisted = parseYamlObject(normalizedRaw, this.configPath);
    const writablePath = resolveWritablePath(this.configPath);
    const writeLock = acquireConfigWriteLock(writablePath);

    try {
      const current = this.readRawSnapshot();
      assertExpectedRevision(current.revision, expectedRevision);
      assertWritablePathUnchanged(this.configPath, writablePath, expectedRevision);
      const changed = !current.existed || normalizedRaw !== current.raw;
      if (!changed) {
        return {
          ...current,
          persisted,
          previousRaw: current.raw,
          previousRevision: current.revision,
          changed: false,
        };
      }

      const backupPath = current.existed ? writeBackup(writablePath, current.raw) : undefined;
      writeTextAtomic(writablePath, normalizedRaw, current.existed, () => {
        assertConfigDocumentUnchanged(
          this.configPath,
          this.fallbackRaw,
          writablePath,
          current.existed,
          current.revision,
        );
      });

      return {
        configPath: this.configPath,
        existed: true,
        raw: normalizedRaw,
        revision: createConfigRevision(normalizedRaw),
        persisted,
        previousRaw: current.raw,
        previousRevision: current.revision,
        changed: true,
        ...(backupPath !== undefined ? { backupPath } : {}),
      };
    } finally {
      writeLock.release();
    }
  }

  private readRawSnapshot(): Omit<ConfigDocumentSnapshot, "persisted"> {
    const existed = existsSync(this.configPath);
    const raw = existed ? readFileSync(this.configPath, "utf-8") : this.fallbackRaw;
    return {
      configPath: this.configPath,
      existed,
      raw,
      revision: createConfigRevision(raw),
    };
  }
}

export function applyPatchesToYamlText(
  raw: string,
  configPath: string,
  patches: readonly ConfigPatch[],
): string {
  const document = parseYamlDocument(raw, configPath);
  for (const patch of patches) {
    if (patch.path.length === 0) {
      throw new Error("配置 patch 路径不能为空");
    }
    switch (patch.op) {
      case "set":
        document.setIn([...patch.path], patch.value);
        break;
      case "delete":
        document.deleteIn([...patch.path]);
        break;
    }
  }
  return document.toString({ lineWidth: 0 });
}

function createPreview(current: ConfigDocumentSnapshot, raw: string): ConfigDocumentPreview {
  const normalizedRaw = normalizeTrailingNewline(raw);
  return {
    configPath: current.configPath,
    existed: current.existed,
    raw: normalizedRaw,
    revision: createConfigRevision(normalizedRaw),
    persisted: parseYamlObject(normalizedRaw, current.configPath),
    previousRaw: current.raw,
    previousRevision: current.revision,
    changed: normalizedRaw !== current.raw,
  };
}

function assertExpectedRevision(
  actualRevision: ConfigRevision,
  expectedRevision: ConfigRevision | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
    throw new ConfigRevisionConflictError(expectedRevision, actualRevision);
  }
}

function parseYamlDocument(raw: string, configPath: string) {
  const document = parseDocument(raw, {
    keepSourceTokens: true,
    prettyErrors: true,
  });
  if (document.errors.length > 0) {
    const [firstError] = document.errors;
    const message = document.errors.map((error) => error.message).join("\n");
    throw new ConfigDocumentParseError(configPath, message, firstError);
  }
  return document;
}

function parseYamlObject(raw: string, configPath: string): Readonly<Record<string, unknown>> {
  const document = parseYamlDocument(raw, configPath);
  const persisted: unknown = document.toJS();
  if (!isRecord(persisted)) {
    throw new ConfigDocumentParseError(configPath, "expected YAML object");
  }
  return persisted;
}

function applyObjectDiff(
  document: ReturnType<typeof parseYamlDocument>,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  path: ConfigPath,
): void {
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      document.deleteIn([...path, key]);
    }
  }

  for (const [key, nextValue] of Object.entries(after)) {
    const previousValue = before[key];
    const nextPath = [...path, key];
    if (isRecord(previousValue) && isRecord(nextValue)) {
      applyObjectDiff(document, previousValue, nextValue, nextPath);
      continue;
    }
    if (!deepEqual(previousValue, nextValue)) {
      document.setIn(nextPath, nextValue);
    }
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
  );
}

function normalizeTrailingNewline(raw: string): string {
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

function resolveWritablePath(configPath: string): string {
  if (!existsSync(configPath)) {
    return configPath;
  }
  return lstatSync(configPath).isSymbolicLink() ? realpathSync(configPath) : configPath;
}

function writeBackup(configPath: string, raw: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace("T", "-")
    .replace("Z", "")
    .replace(".", "-");
  const preferredPath = `${configPath}.bak.${timestamp}`;
  const backupPath = existsSync(preferredPath)
    ? `${preferredPath}.${randomUUID().slice(0, 8)}`
    : preferredPath;
  writeFileSync(backupPath, raw, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  return backupPath;
}

function writeTextAtomic(
  configPath: string,
  raw: string,
  existed: boolean,
  beforeRename?: () => void,
): void {
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
    beforeRename?.();
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

interface ConfigWriteLockFile {
  readonly pid: number;
  readonly token: string;
  readonly createdAtMs: number;
}

interface ConfigWriteLock {
  release(): void;
}

function acquireConfigWriteLock(configPath: string): ConfigWriteLock {
  mkdirSync(dirname(configPath), { recursive: true });
  const lockPath = `${configPath}.roll-write.lock`;
  const record: ConfigWriteLockFile = {
    pid: process.pid,
    token: randomUUID(),
    createdAtMs: Date.now(),
  };
  const raw = `${JSON.stringify(record)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, raw, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          releaseConfigWriteLock(lockPath, record.token);
        },
      };
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      if (attempt === 0 && removeStaleConfigWriteLock(lockPath)) continue;
      throw new ConfigWriteLockError();
    }
  }

  throw new ConfigWriteLockError();
}

function releaseConfigWriteLock(lockPath: string, token: string): void {
  try {
    const current = readConfigWriteLockFile(lockPath);
    if (current?.token === token) unlinkSync(lockPath);
  } catch {
    // Never delete a replacement lock using an older writer's release callback.
  }
}

function removeStaleConfigWriteLock(lockPath: string): boolean {
  let raw: string;
  let modifiedAtMs: number;
  try {
    raw = readFileSync(lockPath, "utf-8");
    modifiedAtMs = statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  const record = parseConfigWriteLockFile(raw);
  const ageMs = Date.now() - (record?.createdAtMs ?? modifiedAtMs);
  const stale = record === undefined ? ageMs > CONFIG_WRITE_LOCK_STALE_MS : !isPidAlive(record.pid);
  if (!stale) return false;

  try {
    if (readFileSync(lockPath, "utf-8") !== raw) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function readConfigWriteLockFile(lockPath: string): ConfigWriteLockFile | undefined {
  if (!existsSync(lockPath)) return undefined;
  return parseConfigWriteLockFile(readFileSync(lockPath, "utf-8"));
}

function parseConfigWriteLockFile(raw: string): ConfigWriteLockFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    typeof value.createdAtMs !== "number" ||
    !Number.isFinite(value.createdAtMs)
  ) {
    return undefined;
  }
  return { pid: value.pid, token: value.token, createdAtMs: value.createdAtMs };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoCode(error, "EPERM");
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertWritablePathUnchanged(
  configPath: string,
  expectedWritablePath: string,
  expectedRevision: ConfigRevision,
): void {
  if (resolveWritablePath(configPath) !== expectedWritablePath) {
    throw new ConfigRevisionConflictError(expectedRevision, expectedRevision);
  }
}

function assertConfigDocumentUnchanged(
  configPath: string,
  fallbackRaw: string,
  expectedWritablePath: string,
  expectedExisted: boolean,
  expectedRevision: ConfigRevision,
): void {
  const actualExisted = existsSync(configPath);
  const actualRaw = actualExisted ? readFileSync(configPath, "utf-8") : fallbackRaw;
  const actualRevision = createConfigRevision(actualRaw);
  if (
    actualExisted !== expectedExisted ||
    actualRevision !== expectedRevision ||
    resolveWritablePath(configPath) !== expectedWritablePath
  ) {
    throw new ConfigRevisionConflictError(expectedRevision, actualRevision);
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
