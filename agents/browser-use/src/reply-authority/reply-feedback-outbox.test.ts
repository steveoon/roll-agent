import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import type { ReplyFeedbackBody } from "@roll-agent/reply-authority-client";
import type { AgentLogger } from "@roll-agent/sdk";
import {
  initializeReplyFeedbackOutbox,
  shutdownReplyFeedbackOutbox,
  submitReplyFeedback,
  type ReplyFeedbackDeliver,
} from "./reply-feedback-outbox.ts";

const logger: AgentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const baseBody = {
  groupId: "group-1",
  target: {
    platform: "zhipin",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
  },
  chosenVariant: "revised",
  feedbackOutcome: "selected",
  decisionSource: "judge",
  confirmedFindingCodes: ["audit_tone"],
  reason: "option_2 is less audit-like and preserves the same factual claims.",
  rubricVersion: "reply-quality-v1",
  rubricHash: `sha256:${"a".repeat(64)}`,
  judgeModel: "mcp-sampling",
} satisfies ReplyFeedbackBody;

let tempDirs: string[] = [];

afterEach(async () => {
  await shutdownReplyFeedbackOutbox();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function createDbPath(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "reply-feedback-outbox-"));
  tempDirs.push(dir);
  return resolve(dir, "outbox.sqlite");
}

function httpError(statusCode: number, message = `HTTP ${statusCode}`): Error {
  return Object.assign(new Error(message), { statusCode });
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${String(timeoutMs)}ms.`);
    }
    await delay(5);
  }
}

function initializeForTest(
  dbPath: string,
  deliver: ReplyFeedbackDeliver,
  options: {
    readonly flushIntervalMs?: number;
    readonly retryBaseDelayMs?: number;
    readonly authRetryDelayMs?: number;
  } = {},
): void {
  initializeReplyFeedbackOutbox({
    dbPath,
    retentionSeconds: 60,
    flushIntervalMs: options.flushIntervalMs ?? 5,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 1,
    authRetryDelayMs: options.authRetryDelayMs ?? 5,
    deliver,
    logger,
  });
}

test("recovers queued feedback from the same database after restart", async () => {
  const dbPath = await createDbPath();
  let firstProcessAttempts = 0;
  const unavailable: ReplyFeedbackDeliver = async () => {
    firstProcessAttempts += 1;
    throw httpError(503);
  };
  initializeForTest(dbPath, unavailable);

  assert.deepEqual(await submitReplyFeedback(baseBody, unavailable, logger), {
    status: "queued",
    error: "HTTP 503",
  });
  assert.equal(firstProcessAttempts, 1);
  await shutdownReplyFeedbackOutbox();

  let recoveredAttempts = 0;
  const recovered: ReplyFeedbackDeliver = async (body) => {
    recoveredAttempts += 1;
    return { status: "accepted", groupId: body.groupId };
  };
  initializeForTest(dbPath, recovered);
  await waitFor(() => recoveredAttempts === 1);

  assert.deepEqual(await submitReplyFeedback(baseBody, recovered, logger), {
    status: "duplicate",
  });
  assert.equal(recoveredAttempts, 1);
});

test("deduplicates an already delivered group with an identical body", async () => {
  const dbPath = await createDbPath();
  let attempts = 0;
  const deliver: ReplyFeedbackDeliver = async (body) => {
    attempts += 1;
    return { status: "accepted", groupId: body.groupId };
  };
  initializeForTest(dbPath, deliver);

  assert.deepEqual(await submitReplyFeedback(baseBody, deliver, logger), {
    status: "accepted",
  });
  assert.deepEqual(await submitReplyFeedback(baseBody, deliver, logger), {
    status: "duplicate",
  });
  assert.equal(attempts, 1);
});

test("rejects the same groupId with a different body hash", async () => {
  const dbPath = await createDbPath();
  let attempts = 0;
  const deliver: ReplyFeedbackDeliver = async (body) => {
    attempts += 1;
    return { status: "accepted", groupId: body.groupId };
  };
  initializeForTest(dbPath, deliver);
  assert.equal((await submitReplyFeedback(baseBody, deliver, logger)).status, "accepted");

  const conflict = await submitReplyFeedback(
    { ...baseBody, reason: "A different decision reason." },
    deliver,
    logger,
  );
  assert.equal(conflict.status, "failed");
  assert.match(conflict.error ?? "", /different payload/);
  assert.equal(attempts, 1);
});

test("retries a transient failure and eventually closes the group", async () => {
  const dbPath = await createDbPath();
  let attempts = 0;
  const deliver: ReplyFeedbackDeliver = async (body) => {
    attempts += 1;
    if (attempts === 1) {
      throw httpError(503, "temporarily unavailable");
    }
    return { status: "accepted", groupId: body.groupId };
  };
  initializeForTest(dbPath, deliver);

  const first = await submitReplyFeedback(baseBody, deliver, logger);
  assert.deepEqual(first, { status: "queued", error: "temporarily unavailable" });
  await waitFor(() => attempts === 2);
  assert.deepEqual(await submitReplyFeedback(baseBody, deliver, logger), {
    status: "duplicate",
  });
  assert.equal(attempts, 2);
});

test("marks permanent client failures dead without retrying", async () => {
  const dbPath = await createDbPath();
  let attempts = 0;
  const deliver: ReplyFeedbackDeliver = async () => {
    attempts += 1;
    throw httpError(422, "feedback payload rejected");
  };
  initializeForTest(dbPath, deliver);

  assert.deepEqual(await submitReplyFeedback(baseBody, deliver, logger), {
    status: "failed",
    error: "feedback payload rejected",
  });
  await delay(30);
  assert.deepEqual(await submitReplyFeedback(baseBody, deliver, logger), {
    status: "failed",
    error: "feedback payload rejected",
  });
  assert.equal(attempts, 1);
});

test("queues 401 and 403 failures on the longer authentication retry interval", async () => {
  for (const statusCode of [401, 403]) {
    const dbPath = await createDbPath();
    let attempts = 0;
    const deliver: ReplyFeedbackDeliver = async () => {
      attempts += 1;
      throw httpError(statusCode);
    };
    initializeForTest(dbPath, deliver, { authRetryDelayMs: 100 });

    assert.equal((await submitReplyFeedback(baseBody, deliver, logger)).status, "queued");
    await delay(30);
    assert.equal(attempts, 1);
    await shutdownReplyFeedbackOutbox();
  }
});

test("caps retry retention at the server-provided feedback deadline", async () => {
  const dbPath = await createDbPath();
  const unavailable: ReplyFeedbackDeliver = async () => {
    throw httpError(503);
  };
  initializeForTest(dbPath, unavailable);
  const feedbackExpiresAt = Math.floor(Date.now() / 1_000) + 30;

  assert.equal(
    (
      await submitReplyFeedback(baseBody, unavailable, logger, {
        feedbackExpiresAt,
      })
    ).status,
    "queued",
  );
  await shutdownReplyFeedbackOutbox();

  const database = new DatabaseSync(dbPath);
  try {
    const row = database
      .prepare("SELECT retry_expires_at FROM reply_feedback_outbox WHERE group_id = ?")
      .get(baseBody.groupId) as { readonly retry_expires_at: number } | undefined;
    assert.equal(row?.retry_expires_at, feedbackExpiresAt * 1_000);
  } finally {
    database.close();
  }
});
