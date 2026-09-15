import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readScheduleLedger } from "@roll-agent/runtime";
import { createDaemonRecord, writeDaemonRecord } from "../../scheduler-host/daemon-record.ts";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../index.ts");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-calendar-cli-"));
  const dataDir = join(root, "scheduler");
  writeFileSync(
    join(root, "roll.config.yaml"),
    JSON.stringify({
      scheduler: { "data-dir": dataDir },
      runtime: { "threads-dir": join(root, "threads") },
      agents: { "data-dir": join(root, "agents") },
    }),
  );
  return {
    root,
    dataDir,
    invoke: (...args: string[]) =>
      exec(process.execPath, ["--experimental-strip-types", cli, "schedule", ...args], {
        cwd: root,
        env: { ...process.env, TZ: "Asia/Shanghai", NO_COLOR: "1" },
        timeout: 30_000,
      }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("real CLI calendar: local future start, default host zone, daily and weekly persist and render", async () => {
  const f = fixture();
  try {
    await f.invoke(
      "add",
      "检查未读",
      "--name",
      "interval",
      "--every",
      "30m",
      "--start-at",
      "2099-01-01T08:00",
      "--rounds",
      "20",
      "--json",
    );
    await f.invoke(
      "add",
      "检查未读",
      "--name",
      "daily",
      "--daily",
      "08:00",
      "--start-at",
      "2099-01-01T08:00",
      "--rounds",
      "20",
      "--json",
    );
    await f.invoke(
      "add",
      "检查未读",
      "--name",
      "weekly",
      "--weekly",
      "fri,mon",
      "--at",
      "08:00",
      "--time-zone",
      "America/New_York",
      "--start-at",
      "2099-01-01T08:00",
      "--json",
    );
    const records = readScheduleLedger(f.dataDir).schedules;
    const interval = records.find((record) => record.name === "interval");
    const daily = records.find((record) => record.name === "daily");
    const weekly = records.find((record) => record.name === "weekly");
    assert.equal(interval?.nextRunAtMs, Date.parse("2099-01-01T00:00:00Z"));
    assert.equal(interval.maxRounds, 20);
    assert.equal(daily?.nextRunAtMs, interval.nextRunAtMs);
    assert.equal(daily?.trigger.kind, "calendar");
    if (daily?.trigger.kind === "calendar") {
      assert.equal(daily.trigger.calendar.timeZone, "Asia/Shanghai");
    }
    assert.equal(weekly?.trigger.kind, "calendar");
    if (weekly?.trigger.kind === "calendar") {
      assert.equal(weekly.trigger.calendar.timeZone, "America/New_York");
      assert.equal(weekly.trigger.calendar.frequency, "weekly");
      if (weekly.trigger.calendar.frequency === "weekly") {
        assert.deepEqual(weekly.trigger.calendar.weekdays, [1, 5]);
      }
    }
    const list = await f.invoke("list", "--json");
    assert.match(list.stdout, /每天 08:00（Asia\/Shanghai）/u);
    assert.match(list.stdout, /周一、周五 08:00（America\/New_York）/u);
    const help = await f.invoke("add", "--help");
    assert.match(help.stdout, /--start-at/u);
    assert.match(help.stdout, /--time-zone/u);
    assert.doesNotMatch(help.stdout, /--startAt|--timeZone/u);
  } finally {
    f.close();
  }
});

test("real CLI calendar: invalid or conflicting flags fail before creating a database", async () => {
  const f = fixture();
  try {
    for (const args of [
      [],
      ["--every", "30m", "--daily", "08:00"],
      ["--daily", "08:00", "--now"],
      ["--weekly", "mon"],
      ["--weekly", "oops", "--at", "08:00"],
      ["--every", "30m", "--start-at", "2099-01-01T08:00", "--now"],
      ["--daily", "08:00", "--time-zone", "Not/AZone"],
    ]) {
      await assert.rejects(f.invoke("add", "检查", "--name", "invalid", ...args));
      assert.equal(existsSync(join(f.dataDir, "schedules.db")), false);
    }
  } finally {
    f.close();
  }
});

test("invalid weekday names report the offending CLI value before creating a ledger", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.invoke("add", "noop", "--name", "invalid", "--weekly", "mon,foo", "--at", "08:00"),
      /--weekly 不支持的星期：foo/u,
    );
    assert.equal(existsSync(join(f.dataDir, "schedules.db")), false);
  } finally {
    f.close();
  }
});

test("diagnostic CLI queries work with a live legacy daemon without upgrading its ledger", async () => {
  const f = fixture();
  try {
    await f.invoke("add", "noop", "--name", "legacy", "--every", "30m", "--json");
    const record = readScheduleLedger(f.dataDir).schedules[0];
    assert.ok(record);
    const path = join(f.dataDir, "schedules.db");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version=8");
    raw.close();
    const before = readFileSync(path);
    writeDaemonRecord(join(f.dataDir, "daemon.json"), createDaemonRecord("legacy"));
    const list = await f.invoke("list", "--json");
    assert.match(list.stdout, /legacy/u);
    await f.invoke("show", record.id, "--json");
    await f.invoke("runs", record.id, "--json");
    const status = await f.invoke("status", "--json");
    assert.match(status.stdout, /"requiresRestart": true/u);
    assert.deepEqual(readFileSync(path), before);
    await assert.rejects(
      f.invoke("add", "noop", "--name", "blocked", "--daily", "08:00"),
      /版本不兼容/u,
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    f.close();
  }
});
