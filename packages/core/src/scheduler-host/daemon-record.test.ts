import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LIVENESS,
  createDaemonRecord,
  createDaemonWorkerId,
  inspectDaemon,
  isDaemonWorkerId,
  isInlineWorkerId,
  readDaemonRecord,
  removeDaemonRecord,
  waitForDaemonGeneration,
  writeDaemonRecord,
} from "./daemon-record.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-daemon-record-"));
}

test("daemon worker id includes a per-generation nonce beyond the PID", () => {
  const first = createDaemonWorkerId(4321);
  const second = createDaemonWorkerId(4321);
  assert.match(first, /^daemon-4321-[0-9a-f-]{36}$/u);
  assert.match(second, /^daemon-4321-[0-9a-f-]{36}$/u);
  assert.notEqual(first, second);
});

test("daemon worker id classifier accepts only legacy PID or PID + UUID generations", () => {
  for (const value of [
    "daemon-1",
    "daemon-4321",
    "daemon-4321-11111111-1111-4111-8111-111111111111",
  ]) {
    assert.equal(isDaemonWorkerId(value), true, value);
  }
  for (const value of [
    undefined,
    "",
    "daemon-",
    "daemon-0",
    "daemon-owned",
    "inline-4321",
    " daemon-4321",
    "DAEMON-4321",
    "daemon-4321\n",
    "daemon-4321\nextra",
  ]) {
    assert.equal(isDaemonWorkerId(value), false, String(value));
  }
});

test("inline worker id classifier accepts only the process PID form", () => {
  assert.equal(isInlineWorkerId("inline-1"), true);
  assert.equal(isInlineWorkerId("inline-4321"), true);
  for (const value of [undefined, "", "inline-", "inline-0", "inline-other", "inline-1\n"]) {
    assert.equal(isInlineWorkerId(value), false, String(value));
  }
});

test("daemon 记录写入、读回、按 pid+token 删除", () => {
  const dir = tempDir();
  const path = join(dir, "nested", "daemon.json");
  try {
    const record = createDaemonRecord("w-test");
    assert.equal(record.pid, process.pid);
    writeDaemonRecord(path, record);
    assert.deepEqual(readDaemonRecord(path), record);
    removeDaemonRecord(path, { ...record, pid: record.pid + 1 });
    assert.deepEqual(readDaemonRecord(path), record);
    removeDaemonRecord(path, record);
    assert.equal(readDaemonRecord(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service generation 随 daemon record 持久化，并作为启动就绪门禁", async () => {
  const dir = tempDir();
  const path = join(dir, "daemon.json");
  try {
    const record = createDaemonRecord("w-service", "service-generation");
    writeDaemonRecord(path, record);
    assert.equal(readDaemonRecord(path)?.serviceGeneration, "service-generation");
    assert.deepEqual(
      await waitForDaemonGeneration(path, "service-generation", { timeoutMs: 0 }),
      record,
    );
    await assert.rejects(
      waitForDaemonGeneration(path, "different-generation", { timeoutMs: 0 }),
      /different-generation/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectDaemon 对当前进程报 running，对不存在的记录/进程报 stopped", () => {
  const dir = tempDir();
  const path = join(dir, "daemon.json");
  try {
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.stopped);
    const record = createDaemonRecord("w-live");
    writeDaemonRecord(path, record);
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.running);
    writeFileSync(path, `${JSON.stringify({ ...record, pid: 4_194_303 })}\n`);
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.stopped);
    writeFileSync(path, "not json\n");
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.stopped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
