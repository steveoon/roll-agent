import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ScheduleStore } from "@roll-agent/runtime";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../index.ts");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-finite-cli-"));
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
      exec(
        process.execPath,
        ["--experimental-strip-types", "--experimental-sqlite", cli, "schedule", ...args],
        { cwd: root, env: { ...process.env, NO_COLOR: "1" }, timeout: 30_000 },
      ),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("real CLI finite add --now, completion, JSON views and controls preserve rounds", async () => {
  const f = fixture();
  try {
    const { stdout } = await f.invoke(
      "add",
      "检查未读消息",
      "--name",
      "有限巡检",
      "--every",
      "30m",
      "--rounds",
      "1",
      "--now",
      "--json",
    );
    const created: unknown = JSON.parse(stdout);
    assert.ok(
      typeof created === "object" &&
        created !== null &&
        "id" in created &&
        typeof created.id === "string",
    );
    const id = created.id;
    const store = new ScheduleStore(f.dataDir);
    try {
      const record = store.getSchedule(id);
      assert.ok(record);
      assert.equal(record.maxRounds, 1);
      assert.equal(record.roundsStarted, 0);
      const claim = store.claimDue({ workerId: "test", nowMs: Date.now(), limit: 1 })[0];
      assert.ok(claim, "--now must make the first automatic round immediately claimable");
      assert.equal(claim.invocation.mode, "scheduled");
      assert.equal(store.getSchedule(id)?.roundsStarted, 1);
      assert.equal(store.getSchedule(id)?.nextRunAtMs, undefined);
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: "completed",
        nowMs: Date.now(),
      });
      assert.equal(store.getSchedule(id)?.status, "completed");
    } finally {
      store.close();
    }
    const list = await f.invoke("list", "--status", "completed", "--json");
    const rows: unknown = JSON.parse(list.stdout);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.rounds, { max: 1, started: 1 });
    assert.match(String(rows[0]?.roundsDisplay), /已结束 · 达到轮数上限/u);
    const show = await f.invoke("show", id);
    assert.match(show.stdout, /roundsDisplay: 已结束/u);
    assert.doesNotMatch(show.stdout, /\[object Object\]/u);
    const status = await f.invoke("status", "--json");
    const summary: unknown = JSON.parse(status.stdout);
    assert.ok(typeof summary === "object" && summary !== null && "schedules" in summary);
    assert.deepEqual(summary.schedules, { total: 1, active: 0, paused: 0, completed: 1 });
    const pause = await f.invoke("pause", id);
    assert.match(pause.stderr, /已结束/u);
    await assert.rejects(f.invoke("resume", id), /已结束|轮数/u);
    const verification = new ScheduleStore(f.dataDir);
    try {
      assert.equal(verification.getSchedule(id)?.status, "completed");
      assert.equal(verification.getSchedule(id)?.roundsStarted, 1);
    } finally {
      verification.close();
    }
  } finally {
    f.close();
  }
});

test("real CLI rejects invalid rounds and accepts omitted unlimited rounds", async () => {
  const f = fixture();
  try {
    for (const rounds of ["0", "1.5", "9007199254740992"]) {
      await assert.rejects(
        f.invoke("add", "检查", "--name", "巡检", "--every", "30m", "--rounds", rounds),
        /正安全整数/u,
      );
    }
    const result = await f.invoke("add", "检查", "--name", "巡检", "--every", "30m", "--json");
    const record: unknown = JSON.parse(result.stdout);
    assert.ok(typeof record === "object" && record !== null && "rounds" in record);
    assert.deepEqual(record.rounds, { max: null, started: 0 });
  } finally {
    f.close();
  }
});
