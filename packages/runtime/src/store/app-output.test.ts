import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APP_OUTPUT_LIMITS, operationIdSchema, type AppOutputResult } from "@roll-agent/protocol";
import { ThreadStore } from "./thread-store.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";

const available: AppOutputResult = {
  status: "available",
  schemaId: "example.candidates",
  schemaVersion: 1,
  remoteReadable: true,
  data: { candidates: [{ name: "李明", scores: [10, 0.5], active: true }], empty: {} },
  fallbackText: "One candidate",
};
function record(output?: AppOutputResult) {
  return createToolExecutionRecord({
    toolCallId: "test-call",
    agentName: "demo",
    toolName: "candidates",
    input: {},
    result: {
      ...successfulToolResult("done"),
      ...(output === undefined ? {} : { appOutput: output }),
    },
  });
}

test("application output survives restart, is separate from evidence, and keeps original fork expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-"));
  let now = new Date("2026-09-17T00:00:00.000Z");
  let store = new ThreadStore(dir, { now: () => now });
  try {
    const thread = store.createThread();
    const item = record(available);
    store.appendToolExecution(thread, item);
    assert.deepEqual(store.getAppOutput(thread, item.id), available);
    assert.deepEqual(store.getAppOutputDescriptor(thread, item.id), {
      status: "available",
      schemaId: "example.candidates",
      schemaVersion: 1,
    });
    const db = new DatabaseSync(join(dir, "threads.db"));
    const row = db.prepare("SELECT record_json FROM tool_executions WHERE id = ?").get(item.id);
    assert.ok(row);
    assert.equal(String(row.record_json).includes("appOutput"), false);
    store.close();
    store = new ThreadStore(dir, { now: () => now });
    assert.deepEqual(store.getAppOutput(thread, item.id), available);
    now = new Date(now.getTime() + 20 * 86400000);
    const fork = store.forkSnapshot(store.readSnapshot(thread));
    assert.deepEqual(store.getAppOutput(fork, item.id), available);
    now = new Date(now.getTime() + 10 * 86400000);
    assert.deepEqual(store.getAppOutput(thread, item.id), { status: "expired" });
    assert.deepEqual(store.getAppOutput(fork, item.id), { status: "expired" });
    assert.ok(
      Number(db.prepare("SELECT SUM(byte_length) AS n FROM operation_app_outputs").get()?.n) > 0,
    );
    store.close();
    store = new ThreadStore(dir, { now: () => now });
    assert.equal(db.prepare("SELECT SUM(byte_length) AS n FROM operation_app_outputs").get()?.n, 0);
    store.deleteThread(thread);
    assert.equal(store.getAppOutput(thread, item.id), undefined);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM operation_app_outputs WHERE thread_id = ?").get(thread)
        ?.n,
      0,
    );
    db.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing, legacy, sensitive and over-budget results remain distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-"));
  const store = new ThreadStore(dir);
  try {
    const thread = store.createThread();
    const legacy = record();
    store.appendToolExecution(thread, legacy);
    assert.deepEqual(store.getAppOutput(thread, legacy.id), { status: "not_provided" });
    assert.equal(store.getAppOutput(thread, "missing"), undefined);
    const secret = record({ ...available, data: { password: "private" } });
    store.appendToolExecution(thread, secret);
    assert.deepEqual(store.getAppOutput(thread, secret.id), {
      status: "rejected",
      reason: "credential_field",
      field: "password",
    });
    const large = record({
      ...available,
      data: { text: "中".repeat(APP_OUTPUT_LIMITS.resultBytes / 3) },
    });
    store.appendToolExecution(thread, large);
    assert.deepEqual(store.getAppOutput(thread, large.id), { status: "too_large" });
    assert.equal(store.getAppOutput(store.createThread(), secret.id), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("result insertion failure rolls back both operation and sequence", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-"));
  const store = new ThreadStore(dir);
  const db = new DatabaseSync(join(dir, "threads.db"));
  try {
    const thread = store.createThread();
    const item = record(available);
    db.exec(
      "CREATE TRIGGER reject_app_output BEFORE INSERT ON operation_app_outputs BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    assert.throws(() => store.appendToolExecution(thread, item), /test failure/);
    assert.equal(store.getAppOutput(thread, item.id), undefined);
    assert.equal(
      db
        .prepare("SELECT next_sequence FROM thread_tool_execution_state WHERE thread_id = ?")
        .get(thread)?.next_sequence,
      0,
    );
    db.exec("DROP TRIGGER reject_app_output");
    assert.equal(store.appendToolExecution(thread, item), 0);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("byte retention removes oldest complete bodies without deleting execution records", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-"));
  const store = new ThreadStore(dir);
  const db = new DatabaseSync(join(dir, "threads.db"));
  try {
    const thread = store.createThread();
    const ids: string[] = [];
    for (let index = 0; index < 68; index++) {
      const item = record({ ...available, data: { text: "x".repeat(250000) } });
      ids.push(item.id);
      store.appendToolExecution(thread, item);
    }
    assert.deepEqual(store.getAppOutput(thread, ids[0]!), { status: "expired" });
    assert.equal(store.getAppOutput(thread, ids.at(-1)!)?.status, "available");
    const row = db
      .prepare("SELECT SUM(byte_length) AS n FROM operation_app_outputs WHERE thread_id = ?")
      .get(thread);
    assert.ok(Number(row?.n) <= APP_OUTPUT_LIMITS.threadBytes);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM tool_executions WHERE thread_id = ?").get(thread)?.n,
      68,
    );
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("count retention expires the oldest body and read-only legacy stores never reconstruct raw", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-"));
  let store = new ThreadStore(dir);
  const db = new DatabaseSync(join(dir, "threads.db"));
  try {
    const thread = store.createThread();
    const first = record(available);
    store.appendToolExecution(thread, first);
    for (let index = 1; index <= APP_OUTPUT_LIMITS.threadRecords; index++) {
      store.appendToolExecution(thread, record(available));
    }
    assert.deepEqual(store.getAppOutput(thread, first.id), { status: "expired" });
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM operation_app_outputs WHERE byte_length > 0").get()?.n,
      2000,
    );
    store.close();
    db.exec("DROP TABLE operation_app_outputs");
    store = new ThreadStore(dir, { readOnly: true });
    assert.deepEqual(store.getAppOutput(thread, first.id), { status: "not_provided" });
    store.close();
    store = new ThreadStore(dir);
    assert.deepEqual(store.getAppOutput(thread, first.id), { status: "not_provided" });
    assert.equal(db.prepare("SELECT count(*) AS n FROM operation_app_outputs").get()?.n, 0);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable event descriptors are immutable after result expiry and legacy event JSON remains readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-events-"));
  let now = new Date("2026-09-17T00:00:00.000Z");
  const store = new ThreadStore(dir, { now: () => now });
  const db = new DatabaseSync(join(dir, "threads.db"));
  try {
    const threadId = store.createThread();
    const item = record(available);
    store.appendToolExecution(threadId, item);
    const event = store.appendRuntimeEvent({
      threadId,
      timestamp: now.toISOString(),
      event: {
        type: "tool.completed",
        operationId: operationIdSchema.parse(item.id),
        toolCallId: item.toolCallId,
        agentName: "demo",
        toolName: "candidates",
        display: "done",
        appOutput: { status: "available", schemaId: "example.candidates", schemaVersion: 1 },
      },
    });
    assert.equal(
      String(db.prepare("SELECT event_json FROM runtime_events").get()?.event_json).includes(
        "appOutput",
      ),
      false,
    );
    assert.deepEqual(store.resumeRuntimeEvents(threadId, null).events[0], event);
    // Leave the event within its independent retention window while aging the output body.
    db.prepare("UPDATE operation_app_outputs SET expires_at = ?").run(now.toISOString());
    now = new Date(now.getTime() + 1000);
    assert.deepEqual(store.getAppOutput(threadId, item.id), { status: "expired" });
    assert.deepEqual(store.resumeRuntimeEvents(threadId, null).events[0], event);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("App result reads never update retention rows, including expired reads and snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-read-"));
  let now = new Date("2026-09-17T00:00:00Z");
  const store = new ThreadStore(dir, { now: () => now });
  const db = new DatabaseSync(join(dir, "threads.db"));
  try {
    const thread = store.createThread();
    const item = record(available);
    store.appendToolExecution(thread, item);
    db.exec(
      "CREATE TRIGGER forbid_result_updates BEFORE UPDATE ON operation_app_outputs BEGIN SELECT RAISE(ABORT, 'read attempted retention write'); END",
    );
    assert.equal(store.getAppOutputDescriptor(thread, item.id)?.status, "available");
    assert.equal(store.getAppOutput(thread, item.id)?.status, "available");
    assert.equal(store.readSnapshot(thread).appOutputs?.[0]?.result.status, "available");
    now = new Date(now.getTime() + APP_OUTPUT_LIMITS.maxAgeMs);
    assert.equal(store.getAppOutputDescriptor(thread, item.id)?.status, "expired");
    assert.equal(store.getAppOutput(thread, item.id)?.status, "expired");
    assert.equal(store.readSnapshot(thread).appOutputs?.[0]?.result.status, "expired");
    assert.ok(
      Number(db.prepare("SELECT SUM(byte_length) AS n FROM operation_app_outputs").get()?.n) > 0,
    );
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("business DTO fields are preserved; credential rejection is distinct from access denial", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-app-output-content-"));
  const store = new ThreadStore(dir);
  try {
    const thread = store.createThread();
    for (const data of [
      { image: "https://cdn.example/a.png" },
      { payload: { data: "plain text" } },
      { items: [], nextPageToken: "abc123" },
      { sku: "SK-20260917-A1" },
      { invite: { token: "join-code-42" } },
    ]) {
      const result = record({ ...available, data });
      store.appendToolExecution(thread, result);
      assert.deepEqual(store.getAppOutput(thread, result.id), { ...available, data });
    }
    const secret = record({ ...available, data: { apiKey: "real-credential-test" } });
    store.appendToolExecution(thread, secret);
    assert.deepEqual(store.getAppOutput(thread, secret.id), {
      status: "rejected",
      reason: "credential_field",
      field: "apikey",
    });
    assert.deepEqual(store.getAppOutputDescriptor(thread, secret.id), {
      status: "rejected",
      reason: "credential_field",
      field: "apikey",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strong credential formats remain blocked in free text without blocking uppercase SKU prefixes", () => {
  for (const value of [
    "sk-" + "a".repeat(40),
    "Bearer " + "a".repeat(40),
    "-----BEGIN PRIVATE KEY-----",
    "ghp_" + "x".repeat(40),
    "eyJ" + "a".repeat(16) + "." + "b".repeat(16) + "." + "c".repeat(32),
  ]) {
    const result: AppOutputResult | undefined = record({
      ...available,
      data: { description: value },
    }).appOutput;
    assert.equal(result?.status, "rejected");
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});
