import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import {
  attachmentIdSchema,
  attachmentMediaTypeSchema,
  RUNTIME_ERROR_CODES,
  RUNTIME_V14_MAX_ATTACHMENT_BYTES,
  RUNTIME_V14_MAX_ATTACHMENT_CHUNK_BYTES,
  RUNTIME_V14_MAX_STAGED_ATTACHMENTS,
  SUPPORTED_ATTACHMENT_MEDIA_TYPES,
  type AttachmentDescriptor,
  type AttachmentId,
  type AttachmentSource,
  type ThreadId,
} from "@roll-agent/protocol";

const DEFAULT_STAGED_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_COMMITTED_TTL_MS = 30 * 60 * 1_000;

const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt", "log", "text"],
  "text/markdown": ["md", "markdown"],
};

export type AttachmentStoreErrorCode =
  | typeof RUNTIME_ERROR_CODES.invalidParams
  | typeof RUNTIME_ERROR_CODES.attachmentNotFound
  | typeof RUNTIME_ERROR_CODES.attachmentNotCommitted
  | typeof RUNTIME_ERROR_CODES.attachmentTooLarge
  | typeof RUNTIME_ERROR_CODES.attachmentTypeUnsupported
  | typeof RUNTIME_ERROR_CODES.attachmentHashMismatch
  | typeof RUNTIME_ERROR_CODES.attachmentQuotaExceeded
  | typeof RUNTIME_ERROR_CODES.attachmentUploadIncomplete
  | typeof RUNTIME_ERROR_CODES.attachmentPathRejected
  | typeof RUNTIME_ERROR_CODES.internalError;

export interface AttachmentStoreFailure {
  readonly ok: false;
  readonly code: AttachmentStoreErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface AttachmentStageInput {
  readonly threadId: ThreadId;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: AttachmentSource;
  readonly sourcePath?: string | undefined;
}

export interface AttachmentStoreOptions {
  readonly dir: string;
  readonly maxAttachmentBytes?: number;
  readonly maxStagedAttachments?: number;
  readonly stagedTtlMs?: number;
  readonly committedTtlMs?: number;
  readonly now?: () => number;
}

interface AttachmentRecord {
  readonly attachmentId: AttachmentId;
  readonly threadId: ThreadId;
  readonly fileName: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly declaredBytes: number;
  readonly declaredSha256: string;
  readonly source: AttachmentSource;
  readonly createdAtMs: number;
  state: "staged" | "committed";
  receivedBytes: number;
  nextSequence: number;
  committedAtMs: number | undefined;
}

function sanitizeDisplayName(fileName: string): string {
  const base = basename(fileName)
    .replace(/[\\/:]+/gu, "")
    .replace(/\p{Cc}+/gu, "")
    .trim();
  return base.length > 0 ? base : "attachment";
}

function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function extensionMatchesMediaType(fileName: string, mediaType: string): boolean {
  const allowed = MEDIA_TYPE_EXTENSIONS[mediaType];
  if (allowed === undefined) {
    return false;
  }
  const extension = extname(fileName).slice(1).toLowerCase();
  return allowed.includes(extension);
}

function sweepStaleInstanceDirs(rootDir: string, staleMs: number): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoffMs = Date.now() - staleMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(rootDir, entry.name);
    try {
      if (lstatSync(path).mtimeMs < cutoffMs) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      continue;
    }
  }
}

export class AttachmentStore {
  private readonly dir: string;
  private readonly maxAttachmentBytes: number;
  private readonly maxStagedAttachments: number;
  private readonly stagedTtlMs: number;
  private readonly committedTtlMs: number;
  private readonly now: () => number;
  private readonly records = new Map<AttachmentId, AttachmentRecord>();
  private closed = false;

  constructor(options: AttachmentStoreOptions) {
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? RUNTIME_V14_MAX_ATTACHMENT_BYTES;
    this.maxStagedAttachments = options.maxStagedAttachments ?? RUNTIME_V14_MAX_STAGED_ATTACHMENTS;
    this.stagedTtlMs = options.stagedTtlMs ?? DEFAULT_STAGED_TTL_MS;
    this.committedTtlMs = options.committedTtlMs ?? DEFAULT_COMMITTED_TTL_MS;
    this.now = options.now ?? Date.now;
    this.dir = join(options.dir, randomUUID());
    sweepStaleInstanceDirs(options.dir, Math.max(this.stagedTtlMs, this.committedTtlMs) * 2);
    mkdirSync(this.dir, { recursive: true });
  }

  get limits(): {
    readonly maxAttachmentBytes: number;
    readonly maxAttachmentChunkBytes: number;
    readonly maxStagedAttachments: number;
  } {
    return {
      maxAttachmentBytes: this.maxAttachmentBytes,
      maxAttachmentChunkBytes: RUNTIME_V14_MAX_ATTACHMENT_CHUNK_BYTES,
      maxStagedAttachments: this.maxStagedAttachments,
    };
  }

  stage(input: AttachmentStageInput):
    | {
        readonly ok: true;
        readonly attachmentId: AttachmentId;
        readonly state: "staged" | "committed";
        readonly descriptor?: AttachmentDescriptor;
      }
    | AttachmentStoreFailure {
    this.sweepExpired();
    if (input.bytes > this.maxAttachmentBytes) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentTooLarge,
        message: `附件超过单文件上限 ${String(this.maxAttachmentBytes)} 字节`,
      };
    }
    if (!(input.mediaType in MEDIA_TYPE_EXTENSIONS)) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentTypeUnsupported,
        message: `不支持的附件类型: ${input.mediaType}（支持 ${SUPPORTED_ATTACHMENT_MEDIA_TYPES.join(", ")}）`,
      };
    }
    if (!extensionMatchesMediaType(input.fileName, input.mediaType)) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentTypeUnsupported,
        message: `文件扩展名与 mediaType "${input.mediaType}" 不一致`,
      };
    }
    if (this.records.size >= this.maxStagedAttachments) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentQuotaExceeded,
        message: `暂存的附件数已达上限 ${String(this.maxStagedAttachments)}，请先在 turn.start 中引用或 release 释放`,
        retryable: true,
      };
    }
    const attachmentId = attachmentIdSchema.parse(randomUUID());
    const record: AttachmentRecord = {
      attachmentId,
      threadId: input.threadId,
      fileName: input.fileName,
      displayName: sanitizeDisplayName(input.fileName),
      mediaType: input.mediaType,
      declaredBytes: input.bytes,
      declaredSha256: input.sha256,
      source: input.source,
      createdAtMs: this.now(),
      state: "staged",
      receivedBytes: 0,
      nextSequence: 0,
      committedAtMs: undefined,
    };
    if (input.source === "chunks") {
      writeFileSync(this.filePath(attachmentId), Buffer.alloc(0));
      this.records.set(attachmentId, record);
      return { ok: true, attachmentId, state: "staged" };
    }
    const loaded = this.loadLocalFile(input.sourcePath ?? "", input.bytes, input.sha256);
    if (!loaded.ok) {
      return loaded;
    }
    writeFileSync(this.filePath(attachmentId), loaded.data);
    record.state = "committed";
    record.receivedBytes = loaded.data.length;
    record.committedAtMs = this.now();
    this.records.set(attachmentId, record);
    return { ok: true, attachmentId, state: "committed", descriptor: this.describe(record) };
  }

  appendChunk(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: AttachmentId;
    readonly sequence: number;
    readonly dataBase64: string;
  }):
    | { readonly ok: true; readonly receivedBytes: number; readonly nextSequence: number }
    | AttachmentStoreFailure {
    this.sweepExpired();
    const record = this.findOwned(input.threadId, input.attachmentId);
    if (record === undefined) {
      return this.notFound(input.attachmentId);
    }
    if (record.state !== "staged" || record.source !== "chunks") {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.invalidParams,
        message: "附件不处于 chunk 上传状态",
      };
    }
    if (input.sequence !== record.nextSequence) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.invalidParams,
        message: `chunk sequence 不连续：期望 ${String(record.nextSequence)}，收到 ${String(input.sequence)}`,
      };
    }
    const data = Buffer.from(input.dataBase64, "base64");
    if (data.length === 0 || data.length > RUNTIME_V14_MAX_ATTACHMENT_CHUNK_BYTES) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.invalidParams,
        message: `chunk 大小必须在 1..${String(RUNTIME_V14_MAX_ATTACHMENT_CHUNK_BYTES)} 字节内`,
      };
    }
    if (record.receivedBytes + data.length > record.declaredBytes) {
      this.remove(record.attachmentId);
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentTooLarge,
        message: "累计上传字节数超过申报大小，附件已回收",
      };
    }
    appendFileSync(this.filePath(record.attachmentId), data);
    record.receivedBytes += data.length;
    record.nextSequence += 1;
    return { ok: true, receivedBytes: record.receivedBytes, nextSequence: record.nextSequence };
  }

  commit(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: AttachmentId;
  }): { readonly ok: true; readonly descriptor: AttachmentDescriptor } | AttachmentStoreFailure {
    this.sweepExpired();
    const record = this.findOwned(input.threadId, input.attachmentId);
    if (record === undefined) {
      return this.notFound(input.attachmentId);
    }
    if (record.state === "committed") {
      return { ok: true, descriptor: this.describe(record) };
    }
    if (record.receivedBytes !== record.declaredBytes) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentUploadIncomplete,
        message: `上传未完成：已收 ${String(record.receivedBytes)} 字节，申报 ${String(record.declaredBytes)} 字节`,
      };
    }
    const data = readFileSync(this.filePath(record.attachmentId));
    if (sha256Of(data) !== record.declaredSha256) {
      this.remove(record.attachmentId);
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentHashMismatch,
        message: "附件内容 sha256 与申报值不匹配，附件已回收",
      };
    }
    record.state = "committed";
    record.committedAtMs = this.now();
    return { ok: true, descriptor: this.describe(record) };
  }

  release(input: { readonly threadId: ThreadId; readonly attachmentId: AttachmentId }): {
    readonly ok: true;
    readonly released: boolean;
  } {
    this.sweepExpired();
    const record = this.findOwned(input.threadId, input.attachmentId);
    if (record === undefined) {
      return { ok: true, released: false };
    }
    this.remove(record.attachmentId);
    return { ok: true, released: true };
  }

  readCommitted(input: { readonly threadId: ThreadId; readonly attachmentId: AttachmentId }):
    | {
        readonly ok: true;
        readonly descriptor: AttachmentDescriptor;
        readonly dataBase64: string;
      }
    | AttachmentStoreFailure {
    this.sweepExpired();
    const record = this.findOwned(input.threadId, input.attachmentId);
    if (record === undefined) {
      return this.notFound(input.attachmentId);
    }
    if (record.state !== "committed") {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentNotCommitted,
        message: `附件 "${input.attachmentId}" 尚未 commit`,
      };
    }
    let data: Buffer;
    try {
      data = readFileSync(this.filePath(record.attachmentId));
    } catch {
      this.remove(record.attachmentId);
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.internalError,
        message: "附件数据文件缺失，附件已回收",
      };
    }
    return {
      ok: true,
      descriptor: this.describe(record),
      dataBase64: data.toString("base64"),
    };
  }

  releaseThread(threadId: ThreadId): void {
    for (const record of [...this.records.values()]) {
      if (record.threadId === threadId) {
        this.remove(record.attachmentId);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.records.clear();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private describe(record: AttachmentRecord): AttachmentDescriptor {
    return {
      attachmentId: record.attachmentId,
      fileName: record.fileName,
      displayName: record.displayName,
      mediaType: attachmentMediaTypeSchema.parse(record.mediaType),
      bytes: record.declaredBytes,
      sha256: record.declaredSha256,
      source: record.source,
      createdAt: new Date(record.createdAtMs).toISOString(),
    };
  }

  private loadLocalFile(
    sourcePath: string,
    declaredBytes: number,
    declaredSha256: string,
  ): { readonly ok: true; readonly data: Buffer } | AttachmentStoreFailure {
    if (!isAbsolute(sourcePath)) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentPathRejected,
        message: "sourcePath 必须是绝对路径",
      };
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(sourcePath);
    } catch {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentPathRejected,
        message: "sourcePath 不存在或不可读",
      };
    }
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentPathRejected,
        message: "sourcePath 不允许是符号链接",
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentPathRejected,
        message: "sourcePath 不是普通文件",
      };
    }
    if (stats.size > this.maxAttachmentBytes) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentTooLarge,
        message: `文件实际大小 ${String(stats.size)} 超过单文件上限 ${String(this.maxAttachmentBytes)} 字节`,
      };
    }
    if (stats.size !== declaredBytes) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.invalidParams,
        message: `文件实际大小 ${String(stats.size)} 与申报 ${String(declaredBytes)} 不一致`,
      };
    }
    const data = readFileSync(sourcePath);
    if (sha256Of(data) !== declaredSha256) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODES.attachmentHashMismatch,
        message: "文件内容 sha256 与申报值不匹配",
      };
    }
    return { ok: true, data };
  }

  private findOwned(threadId: ThreadId, attachmentId: AttachmentId): AttachmentRecord | undefined {
    const record = this.records.get(attachmentId);
    if (record === undefined || record.threadId !== threadId) {
      return undefined;
    }
    return record;
  }

  private notFound(attachmentId: AttachmentId): AttachmentStoreFailure {
    return {
      ok: false,
      code: RUNTIME_ERROR_CODES.attachmentNotFound,
      message: `附件 "${attachmentId}" 不存在、已过期或不属于该 Thread`,
    };
  }

  private remove(attachmentId: AttachmentId): void {
    this.records.delete(attachmentId);
    rmSync(this.filePath(attachmentId), { force: true });
  }

  private sweepExpired(): void {
    const nowMs = this.now();
    for (const record of [...this.records.values()]) {
      const ttl = record.state === "staged" ? this.stagedTtlMs : this.committedTtlMs;
      const referenceMs = record.committedAtMs ?? record.createdAtMs;
      if (nowMs - referenceMs > ttl) {
        this.remove(record.attachmentId);
      }
    }
  }

  private filePath(attachmentId: AttachmentId): string {
    return join(this.dir, `${attachmentId}.bin`);
  }
}
