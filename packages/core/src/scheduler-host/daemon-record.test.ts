import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LIVENESS,
  createDaemonRecord,
  inspectDaemon,
  readDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "./daemon-record.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-daemon-record-"));
}

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
