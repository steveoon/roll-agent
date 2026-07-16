import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  postReplyFeedback,
  ReplyFeedbackBodySchema,
  type ReplyFeedbackBody,
  type ReplyFeedbackResponse,
} from "@roll-agent/reply-authority-client";
import { createAgentLogger, type AgentLogger } from "@roll-agent/sdk";

const DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_AUTH_RETRY_DELAY_MS = 15 * 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const FLUSH_BATCH_SIZE = 50;

const OUTBOX_STATE_VALUES = ["pending", "delivered", "dead"] as const;
type OutboxState = (typeof OUTBOX_STATE_VALUES)[number];
const OUTBOX_STATE_SQL = OUTBOX_STATE_VALUES.map((state) => `'${state}'`).join(", ");

export const REPLY_FEEDBACK_SUBMISSION_STATUS_VALUES = [
  "accepted",
  "duplicate",
  "queued",
  "failed",
] as const;
export type ReplyFeedbackSubmissionStatus =
  (typeof REPLY_FEEDBACK_SUBMISSION_STATUS_VALUES)[number];

export interface ReplyFeedbackSubmissionResult {
  readonly status: ReplyFeedbackSubmissionStatus;
  readonly error?: string;
}

export interface SubmitReplyFeedbackOptions {
  readonly feedbackExpiresAt?: number;
}

export type ReplyFeedbackDeliver = (body: ReplyFeedbackBody) => Promise<ReplyFeedbackResponse>;

export interface InitializeReplyFeedbackOutboxOptions {
  readonly dbPath?: string;
  readonly retentionSeconds?: number;
  readonly flushIntervalMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly authRetryDelayMs?: number;
  readonly deliver?: ReplyFeedbackDeliver;
  readonly logger?: AgentLogger;
}

interface OutboxRow {
  readonly group_id: string;
  readonly body_json: string;
  readonly body_hash: string;
  readonly state: OutboxState;
  readonly attempt_count: number;
  readonly next_attempt_at: number;
  readonly retry_expires_at: number;
  readonly delete_after: number;
  readonly delivered_status: "accepted" | "duplicate" | null;
  readonly last_status_code: number | null;
  readonly last_error: string | null;
}

interface ReplyFeedbackOutboxRuntime {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly retentionMs: number;
  readonly flushIntervalMs: number;
  readonly retryBaseDelayMs: number;
  readonly authRetryDelayMs: number;
  readonly timer: NodeJS.Timeout;
  operationQueue: Promise<void>;
  deliver: ReplyFeedbackDeliver;
  logger: AgentLogger;
  closing: boolean;
  backgroundFlushQueued: boolean;
}

const fallbackLogger = createAgentLogger("browser-use-agent:reply-feedback-outbox");
let activeRuntime: ReplyFeedbackOutboxRuntime | undefined;
let shutdownPromise: Promise<void> | undefined;

function expandTilde(path: string): string {
  if (path === "~") {
    return homedir();
  }
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

function defaultDbPath(): string {
  return resolve(homedir(), ".roll-agent", "browser", "reply-feedback-outbox.sqlite");
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function resolveConfig(options: InitializeReplyFeedbackOutboxOptions): {
  readonly dbPath: string;
  readonly retentionMs: number;
  readonly flushIntervalMs: number;
  readonly retryBaseDelayMs: number;
  readonly authRetryDelayMs: number;
} {
  const retentionSeconds =
    options.retentionSeconds ??
    parsePositiveIntegerEnv("REPLY_FEEDBACK_OUTBOX_RETENTION_SECONDS", DEFAULT_RETENTION_SECONDS);
  const flushIntervalMs =
    options.flushIntervalMs ??
    parsePositiveIntegerEnv("REPLY_FEEDBACK_OUTBOX_FLUSH_INTERVAL_MS", DEFAULT_FLUSH_INTERVAL_MS);
  const configuredDbPath =
    options.dbPath ?? process.env["REPLY_FEEDBACK_OUTBOX_DB_PATH"]?.trim() ?? defaultDbPath();
  if (!configuredDbPath) {
    throw new Error("reply feedback outbox dbPath must not be empty.");
  }
  const dbPath = expandTilde(configuredDbPath);
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const authRetryDelayMs = options.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS;

  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds <= 0) {
    throw new Error("reply feedback outbox retentionSeconds must be a positive integer.");
  }
  if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs <= 0) {
    throw new Error("reply feedback outbox flushIntervalMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs <= 0) {
    throw new Error("reply feedback outbox retryBaseDelayMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(authRetryDelayMs) || authRetryDelayMs <= 0) {
    throw new Error("reply feedback outbox authRetryDelayMs must be a positive integer.");
  }

  return {
    dbPath,
    retentionMs: retentionSeconds * 1_000,
    flushIntervalMs,
    retryBaseDelayMs,
    authRetryDelayMs,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => Reflect.get(value, key) !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported reply feedback value type: ${typeof value}`);
}

function hashBody(bodyJson: string): string {
  return createHash("sha256").update(bodyJson).digest("hex");
}

function resolveRetryExpiresAt(
  now: number,
  retentionMs: number,
  feedbackExpiresAt: number | undefined,
): number {
  if (feedbackExpiresAt === undefined) {
    return now + retentionMs;
  }
  if (
    !Number.isSafeInteger(feedbackExpiresAt) ||
    feedbackExpiresAt < 0 ||
    feedbackExpiresAt > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    throw new Error("feedbackExpiresAt must be a non-negative Unix timestamp in seconds.");
  }
  return Math.min(now + retentionMs, feedbackExpiresAt * 1_000);
}

function getRow(db: DatabaseSync, groupId: string): OutboxRow | undefined {
  return db
    .prepare(
      `SELECT group_id, body_json, body_hash, state, attempt_count, next_attempt_at,
              retry_expires_at, delete_after, delivered_status, last_status_code, last_error
         FROM reply_feedback_outbox
        WHERE group_id = ?`,
    )
    .get(groupId) as unknown as OutboxRow | undefined;
}

function parseStoredBody(row: OutboxRow): ReplyFeedbackBody {
  return ReplyFeedbackBodySchema.parse(JSON.parse(row.body_json));
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const statusCode = Reflect.get(error, "statusCode");
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
}

function isAuthRetry(statusCode: number | undefined): boolean {
  return statusCode === 401 || statusCode === 403;
}

function isTransientFailure(statusCode: number | undefined): boolean {
  if (statusCode === undefined || isAuthRetry(statusCode)) {
    return true;
  }
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function computeRetryDelayMs(runtime: ReplyFeedbackOutboxRuntime, row: OutboxRow): number {
  if (isAuthRetry(row.last_status_code ?? undefined)) {
    return runtime.authRetryDelayMs;
  }
  const exponent = Math.min(Math.max(row.attempt_count - 1, 0), 10);
  return Math.min(runtime.retryBaseDelayMs * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

function enqueueOperation<T>(
  runtime: ReplyFeedbackOutboxRuntime,
  operation: () => Promise<T>,
): Promise<T> {
  const result = runtime.operationQueue.then(operation);
  runtime.operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function expireAndPurge(runtime: ReplyFeedbackOutboxRuntime, now: number): void {
  runtime.db
    .prepare(
      `UPDATE reply_feedback_outbox
          SET state = 'dead',
              last_error = 'Reply feedback outbox retention expired before delivery.',
              updated_at = ?,
              delete_after = ?
        WHERE state = 'pending' AND retry_expires_at <= ?`,
    )
    .run(now, now + runtime.retentionMs, now);
  runtime.db
    .prepare("DELETE FROM reply_feedback_outbox WHERE state <> 'pending' AND delete_after <= ?")
    .run(now);
}

function updateDelivered(
  runtime: ReplyFeedbackOutboxRuntime,
  row: OutboxRow,
  status: "accepted" | "duplicate",
  now: number,
): void {
  runtime.db
    .prepare(
      `UPDATE reply_feedback_outbox
          SET state = 'delivered', delivered_status = ?, last_status_code = NULL,
              last_error = NULL, updated_at = ?, delete_after = ?
        WHERE group_id = ? AND body_hash = ?`,
    )
    .run(status, now, now + runtime.retentionMs, row.group_id, row.body_hash);
}

function updateFailure(
  runtime: ReplyFeedbackOutboxRuntime,
  row: OutboxRow,
  error: unknown,
  now: number,
): ReplyFeedbackSubmissionResult {
  const statusCode = getStatusCode(error);
  const message = formatError(error);
  const transient = isTransientFailure(statusCode) && now < row.retry_expires_at;

  if (transient) {
    const rowWithFailure = { ...row, last_status_code: statusCode ?? null };
    const nextAttemptAt = now + computeRetryDelayMs(runtime, rowWithFailure);
    runtime.db
      .prepare(
        `UPDATE reply_feedback_outbox
            SET state = 'pending', next_attempt_at = ?, last_status_code = ?, last_error = ?,
                updated_at = ?
          WHERE group_id = ? AND body_hash = ?`,
      )
      .run(nextAttemptAt, statusCode ?? null, message, now, row.group_id, row.body_hash);
    runtime.logger.warn(
      `Reply feedback queued for retry: groupId=${row.group_id} statusCode=${statusCode ?? "network"} ` +
        `nextAttemptAt=${new Date(nextAttemptAt).toISOString()} error=${message}`,
    );
    return { status: "queued", error: message };
  }

  runtime.db
    .prepare(
      `UPDATE reply_feedback_outbox
          SET state = 'dead', last_status_code = ?, last_error = ?, updated_at = ?,
              delete_after = ?
        WHERE group_id = ? AND body_hash = ?`,
    )
    .run(statusCode ?? null, message, now, now + runtime.retentionMs, row.group_id, row.body_hash);
  runtime.logger.error(
    `Reply feedback moved to dead state: groupId=${row.group_id} ` +
      `statusCode=${statusCode ?? "network"} error=${message}`,
  );
  return { status: "failed", error: message };
}

async function attemptDelivery(
  runtime: ReplyFeedbackOutboxRuntime,
  row: OutboxRow,
): Promise<ReplyFeedbackSubmissionResult> {
  const now = Date.now();
  if (now >= row.retry_expires_at) {
    return updateFailure(runtime, row, new Error("Reply feedback outbox retention expired."), now);
  }

  runtime.db
    .prepare(
      `UPDATE reply_feedback_outbox
          SET attempt_count = attempt_count + 1, updated_at = ?
        WHERE group_id = ? AND body_hash = ?`,
    )
    .run(now, row.group_id, row.body_hash);

  try {
    const response = await runtime.deliver(parseStoredBody(row));
    if (response.status !== "accepted" && response.status !== "duplicate") {
      throw new Error(`Unexpected reply feedback response status: ${String(response.status)}`);
    }
    if (response.groupId !== row.group_id) {
      throw new Error(
        `Reply feedback response groupId mismatch: expected ${row.group_id}, got ${response.groupId}.`,
      );
    }
    const deliveredAt = Date.now();
    updateDelivered(runtime, row, response.status, deliveredAt);
    runtime.logger.debug(
      `Reply feedback delivered: groupId=${row.group_id} status=${response.status}`,
    );
    return { status: response.status };
  } catch (error) {
    const currentRow = getRow(runtime.db, row.group_id) ?? row;
    return updateFailure(runtime, currentRow, error, Date.now());
  }
}

async function flushDue(runtime: ReplyFeedbackOutboxRuntime): Promise<void> {
  const now = Date.now();
  expireAndPurge(runtime, now);
  const rows = runtime.db
    .prepare(
      `SELECT group_id, body_json, body_hash, state, attempt_count, next_attempt_at,
              retry_expires_at, delete_after, delivered_status, last_status_code, last_error
         FROM reply_feedback_outbox
        WHERE state = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, rowid ASC
        LIMIT ?`,
    )
    .all(now, FLUSH_BATCH_SIZE) as unknown as OutboxRow[];

  for (const row of rows) {
    await attemptDelivery(runtime, row);
  }
}

function scheduleBackgroundFlush(runtime: ReplyFeedbackOutboxRuntime): void {
  if (runtime.closing || runtime.backgroundFlushQueued) {
    return;
  }
  runtime.backgroundFlushQueued = true;
  enqueueOperation(runtime, () => flushDue(runtime))
    .catch((error: unknown) => {
      runtime.logger.error(
        `Reply feedback outbox flush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      runtime.backgroundFlushQueued = false;
    });
}

function initializeDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reply_feedback_outbox (
        group_id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (${OUTBOX_STATE_SQL})),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        retry_expires_at INTEGER NOT NULL,
        delete_after INTEGER NOT NULL,
        delivered_status TEXT CHECK (delivered_status IN ('accepted', 'duplicate')),
        last_status_code INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reply_feedback_outbox_due_idx
        ON reply_feedback_outbox (state, next_attempt_at);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function initializeReplyFeedbackOutbox(
  options: InitializeReplyFeedbackOutboxOptions = {},
): void {
  if (activeRuntime && !activeRuntime.closing) {
    activeRuntime.deliver = options.deliver ?? activeRuntime.deliver;
    activeRuntime.logger = options.logger ?? activeRuntime.logger;
    return;
  }
  if (activeRuntime?.closing || shutdownPromise) {
    throw new Error("Reply feedback outbox is shutting down.");
  }

  const config = resolveConfig(options);
  const db = initializeDatabase(config.dbPath);
  const timer = setInterval(() => {
    const runtime = activeRuntime;
    if (runtime) {
      scheduleBackgroundFlush(runtime);
    }
  }, config.flushIntervalMs);
  timer.unref();

  const runtime: ReplyFeedbackOutboxRuntime = {
    db,
    dbPath: config.dbPath,
    retentionMs: config.retentionMs,
    flushIntervalMs: config.flushIntervalMs,
    retryBaseDelayMs: config.retryBaseDelayMs,
    authRetryDelayMs: config.authRetryDelayMs,
    timer,
    operationQueue: Promise.resolve(),
    deliver: options.deliver ?? postReplyFeedback,
    logger: options.logger ?? fallbackLogger,
    closing: false,
    backgroundFlushQueued: false,
  };
  activeRuntime = runtime;
  runtime.logger.info(`Reply feedback outbox initialized: dbPath=${runtime.dbPath}`);
  scheduleBackgroundFlush(runtime);
}

export async function shutdownReplyFeedbackOutbox(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  const runtime = activeRuntime;
  if (!runtime) {
    return;
  }

  runtime.closing = true;
  clearInterval(runtime.timer);
  shutdownPromise = (async () => {
    await runtime.operationQueue;
    try {
      runtime.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      runtime.db.close();
      if (activeRuntime === runtime) {
        activeRuntime = undefined;
      }
    }
  })().finally(() => {
    shutdownPromise = undefined;
  });
  return shutdownPromise;
}

export async function submitReplyFeedback(
  body: ReplyFeedbackBody,
  deliver: ReplyFeedbackDeliver,
  logger: AgentLogger,
  options: SubmitReplyFeedbackOptions = {},
): Promise<ReplyFeedbackSubmissionResult> {
  if (!activeRuntime) {
    initializeReplyFeedbackOutbox({ deliver, logger });
  }
  const runtime = activeRuntime;
  if (!runtime || runtime.closing) {
    return { status: "failed", error: "Reply feedback outbox is not available." };
  }

  runtime.deliver = deliver;
  runtime.logger = logger;
  const parsedBody = ReplyFeedbackBodySchema.parse(body);
  const bodyJson = stableStringify(parsedBody);
  const bodyHash = hashBody(bodyJson);

  return enqueueOperation(runtime, async () => {
    const now = Date.now();
    const retryExpiresAt = resolveRetryExpiresAt(
      now,
      runtime.retentionMs,
      options.feedbackExpiresAt,
    );
    expireAndPurge(runtime, now);
    const inserted = runtime.db
      .prepare(
        `INSERT INTO reply_feedback_outbox (
           group_id, body_json, body_hash, state, attempt_count, next_attempt_at,
           retry_expires_at, delete_after, delivered_status, last_status_code, last_error,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(group_id) DO NOTHING`,
      )
      .run(
        parsedBody.groupId,
        bodyJson,
        bodyHash,
        now,
        retryExpiresAt,
        retryExpiresAt + runtime.retentionMs,
        now,
        now,
      );
    let row = getRow(runtime.db, parsedBody.groupId);
    if (!row) {
      return { status: "failed", error: "Reply feedback outbox insert failed." };
    }
    if (row.body_hash !== bodyHash) {
      return {
        status: "failed",
        error: `Reply feedback group ${parsedBody.groupId} already has a different payload.`,
      };
    }
    if (row.state === "pending" && row.retry_expires_at > retryExpiresAt) {
      runtime.db
        .prepare(
          `UPDATE reply_feedback_outbox
              SET retry_expires_at = ?, delete_after = MIN(delete_after, ?), updated_at = ?
            WHERE group_id = ? AND body_hash = ? AND state = 'pending'`,
        )
        .run(
          retryExpiresAt,
          retryExpiresAt + runtime.retentionMs,
          now,
          row.group_id,
          row.body_hash,
        );
      row = getRow(runtime.db, parsedBody.groupId) ?? row;
    }
    if (row.state === "delivered") {
      return { status: "duplicate" };
    }
    if (row.state === "dead") {
      return { status: "failed", error: row.last_error ?? "Reply feedback is permanently dead." };
    }
    if (inserted.changes === 0 && row.next_attempt_at > now) {
      return { status: "queued", ...(row.last_error ? { error: row.last_error } : {}) };
    }
    return attemptDelivery(runtime, row);
  });
}
