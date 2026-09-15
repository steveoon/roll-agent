import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, readScheduleOccupancy } from "./schedule-store.ts";
import { DatabaseSync } from "node:sqlite";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const START = NOW + 86_400_000;
const storeUrl = new URL("./schedule-store.ts", import.meta.url).href;

function message(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const listener = (value: unknown) => {
      if (typeof value !== "string") return;
      if (value === expected || value.startsWith(`${expected}:`)) {
        child.off("message", listener);
        resolve(value);
      } else if (value.startsWith("error:")) {
        child.off("message", listener);
        reject(new Error(value));
      }
    };
    child.on("message", listener);
    child.once("error", reject);
  });
}

function worker(code: string): ChildProcess {
  return spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", code],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
}

test(
  "two real processes claim the same calendar occurrence through a release barrier",
  { timeout: 15_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-calendar-race-"));
    const store = new ScheduleStore(dir);
    const children: ChildProcess[] = [];
    try {
      const schedule = store.createSchedule(
        {
          name: "race",
          prompt: "noop",
          cwd: "/workspace",
          maxRounds: 20,
          trigger: {
            kind: "calendar",
            calendar: { frequency: "daily", time: "08:00", timeZone: "Asia/Shanghai" },
          },
        },
        NOW,
      );
      const code = `import {ScheduleStore} from ${JSON.stringify(storeUrl)};
      const store=new ScheduleStore(${JSON.stringify(dir)});process.send('ready');
      process.once('message',()=>{try{const claims=store.claimDue({workerId:'worker-'+process.pid,nowMs:${START},limit:1});
      process.send('result:'+claims.length);}catch(e){process.send('error:'+e.stack);}finally{store.close();process.disconnect();}});`;
      children.push(worker(code), worker(code));
      await Promise.all(children.map((child) => message(child, "ready")));
      const results = children.map((child) => message(child, "result"));
      children.forEach((child) => child.send("go"));
      assert.deepEqual((await Promise.all(results)).sort(), ["result:0", "result:1"]);
      assert.equal(store.getSchedule(schedule.id)?.roundsStarted, 1);
      assert.equal(store.listInvocations(schedule.id).length, 1);
    } finally {
      children.forEach((child) => child.kill());
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "approval expiry during a real SQLite writer lock is checked after BEGIN acquires the lock",
  { timeout: 15_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-calendar-lock-"));
    const clockPath = join(dir, "clock");
    writeFileSync(clockPath, String(NOW));
    const store = new ScheduleStore(dir);
    const children: ChildProcess[] = [];
    try {
      const writer = worker(`import {ScheduleStore} from ${JSON.stringify(storeUrl)};
      import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
      const store=new ScheduleStore(${JSON.stringify(dir)});Date.now=()=>Number(readFileSync(${JSON.stringify(clockPath)},'utf8'));
      const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==='BEGIN IMMEDIATE')process.send('begin');return original.call(this,sql);};
      process.send('ready');process.once('message',()=>{try{store.createSchedule({name:'late',prompt:'noop',cwd:'/workspace',
        trigger:{kind:'calendar',calendar:{frequency:'daily',time:'08:00',timeZone:'Asia/Shanghai'}},expectedFirstRunAtMs:${START}});
        process.send('result:accepted');}catch(e){process.send('result:'+e.message);}finally{store.close();process.disconnect();}});`);
      children.push(writer);
      await message(writer, "ready");
      const blocker =
        worker(`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(dir, "schedules.db"))});
      db.exec('BEGIN IMMEDIATE');process.send('locked');process.once('message',()=>{db.exec('COMMIT');db.close();process.disconnect();});`);
      children.push(blocker);
      await message(blocker, "locked");
      const entered = message(writer, "begin");
      const result = message(writer, "result");
      writer.send("go");
      await entered;
      writeFileSync(clockPath, String(START + 1));
      blocker.send("release");
      assert.match(await result, /重新发起确认/u);
      assert.equal(store.listSchedules().length, 0);
    } finally {
      children.forEach((child) => child.kill());
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("pre-upgrade connection cannot mutate a v9 ledger; readonly maintenance does not upgrade v8", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-calendar-version-"));
  const store = new ScheduleStore(dir);
  const raw = new DatabaseSync(join(dir, "schedules.db"));
  try {
    const s = store.createSchedule(
      {
        name: "version",
        prompt: "noop",
        cwd: "/workspace",
        trigger: { kind: "interval", everyMs: 60_000 },
      },
      NOW,
    );
    for (const statement of [
      `UPDATE schedules SET status='paused'`,
      `DELETE FROM schedules`,
      `UPDATE invocations SET status='completed'`,
    ]) {
      // Seed invocations so each tested row trigger actually runs.
      if (statement.startsWith("UPDATE invocations")) {
        const invocation = store.enqueueManualInvocation(s.id, NOW);
        assert.ok(store.claimPendingInvocation(invocation.id, "worker", NOW));
      }
      assert.throws(() => raw.exec(statement), /writer version mismatch/u);
    }
    assert.equal(store.getSchedule(s.id)?.status, "active");
    raw.exec("PRAGMA user_version=8");
    assert.equal(readScheduleOccupancy(dir).length, 1);
    assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, 8);
  } finally {
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
