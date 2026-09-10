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
  const cwd = mkdtempSync(join(tmpdir(), "roll-cli-extend-"));
  const dataDir = join(cwd, "scheduler");
  writeFileSync(
    join(cwd, "roll.config.yaml"),
    JSON.stringify({
      scheduler: { "data-dir": dataDir },
      runtime: { "threads-dir": join(cwd, "threads") },
      agents: { "data-dir": join(cwd, "agents") },
    }),
  );
  const store = new ScheduleStore(dataDir);
  const schedule = store.createSchedule(
    {
      name: "巡检",
      prompt: "检查",
      cwd,
      trigger: { kind: "interval", everyMs: 60_000 },
      maxRounds: 1,
      fireImmediately: true,
    },
    0,
  );
  const claim = store.claimDue({ workerId: "test", nowMs: 1, limit: 1 })[0];
  assert.ok(claim);
  store.beginInvocation(claim.invocation.id, claim.ownershipToken, 2);
  store.completeInvocation({
    id: claim.invocation.id,
    ownershipToken: claim.ownershipToken,
    status: "completed",
    nowMs: 3,
  });
  store.close();
  return {
    dataDir,
    schedule,
    invoke: (...args: string[]) =>
      exec(
        process.execPath,
        [
          "--experimental-strip-types",
          "--experimental-sqlite",
          cli,
          "schedule",
          "extend",
          schedule.id,
          ...args,
        ],
        { cwd, env: { ...process.env, NO_COLOR: "1" }, timeout: 30_000 },
      ),
    close: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("CLI extends completed task and reuses request receipt when original base is omitted on retry", async () => {
  const f = fixture();
  try {
    const first = await f.invoke("--rounds", "30", "--json");
    const output: unknown = JSON.parse(first.stdout);
    assert.ok(
      typeof output === "object" &&
        output !== null &&
        "requestId" in output &&
        typeof output.requestId === "string",
    );
    assert.match(output.requestId, /^[0-9a-f-]{36}$/u);
    assert.match(first.stderr, new RegExp(output.requestId, "u"));
    const store = new ScheduleStore(f.dataDir);
    const extended = store.getSchedule(f.schedule.id);
    store.close();
    assert.equal(extended?.maxRounds, 31);
    assert.equal(extended.roundsStarted, 1);
    assert.equal(extended.status, "active");
    const replay = await f.invoke("--rounds", "30", "--request-id", output.requestId, "--json");
    const repeated: unknown = JSON.parse(replay.stdout);
    assert.ok(typeof repeated === "object" && repeated !== null && "extended" in repeated);
    assert.equal(repeated.extended, false);
    const check = new ScheduleStore(f.dataDir);
    try {
      assert.equal(check.getSchedule(f.schedule.id)?.maxRounds, 31);
      assert.equal(check.getSchedule(f.schedule.id)?.nextRunAtMs, extended.nextRunAtMs);
    } finally {
      check.close();
    }
    await assert.rejects(
      f.invoke("--rounds", "31", "--request-id", output.requestId),
      /requestId|请求/u,
    );
    await assert.rejects(
      f.invoke("--rounds", "30", "--request-id", "another", "--expected-max-rounds", "1"),
      /变化|预期|额度|已结束/u,
    );
  } finally {
    f.close();
  }
});

test("CLI extension rejects invalid rounds without altering completed quota", async () => {
  const f = fixture();
  try {
    for (const rounds of ["0", "1.5", "9007199254740992"]) {
      await assert.rejects(f.invoke("--rounds", rounds), /正安全整数/u);
    }
    const store = new ScheduleStore(f.dataDir);
    try {
      assert.equal(store.getSchedule(f.schedule.id)?.maxRounds, 1);
      assert.equal(store.getSchedule(f.schedule.id)?.status, "completed");
    } finally {
      store.close();
    }
  } finally {
    f.close();
  }
});
