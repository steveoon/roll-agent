import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduleStore, readScheduleLedger } from "./schedule-store.ts";
import {
  CANCEL_INVOCATION_OUTCOMES,
  COMPLETE_INVOCATION_OUTCOMES,
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_MODES,
  INVOCATION_STATUSES,
  INVOCATION_TREE_LIVENESS,
  SCHEDULE_STATUSES,
  SCHEDULE_STORE_ERROR_CODES,
  ScheduleStoreError,
} from "./types.ts";
import { createIntervalTrigger } from "./trigger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-schedules-"));
}

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

function sampleInput(overrides: Partial<Parameters<ScheduleStore["createSchedule"]>[0]> = {}) {
  return {
    name: "每日巡检",
    prompt: "检查未读消息并汇总",
    cwd: "/workspace/demo",
    trigger: createIntervalTrigger("30m"),
    ...overrides,
  };
}

test("ScheduleStore 创建、查询、列出与删除 schedule", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    assert.equal(created.status, SCHEDULE_STATUSES.active);
    assert.equal(created.nextRunAtMs, NOW + 1_800_000);
    assert.equal(created.lastRunAtMs, undefined);
    assert.deepEqual(store.getSchedule(created.id), created);
    assert.deepEqual(
      store.listSchedules().map((s) => s.id),
      [created.id],
    );
    assert.equal(store.removeSchedule(created.id), true);
    assert.equal(store.removeSchedule(created.id), false);
    assert.equal(store.getSchedule(created.id), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireExistingDatabase refuses to create a missing authoritative ledger", () => {
  const dir = tempDir();
  try {
    const missingDir = join(dir, "missing");
    assert.throws(
      () => new ScheduleStore(missingDir, { requireExistingDatabase: true }),
      /authoritative scheduler database does not exist/u,
    );
    assert.equal(existsSync(missingDir), false);
    assert.throws(
      () => new ScheduleStore(dir, { requireExistingDatabase: true }),
      /authoritative scheduler database does not exist/u,
    );
    assert.equal(existsSync(join(dir, "schedules.db")), false);
    const created = new ScheduleStore(dir);
    created.close();
    const reopened = new ScheduleStore(dir, { requireExistingDatabase: true });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireExistingDatabase rejects empty and unrelated SQLite files without initializing them", () => {
  for (const fixture of ["empty", "unrelated"] as const) {
    const dir = tempDir();
    const databasePath = join(dir, "schedules.db");
    try {
      if (fixture === "empty") {
        writeFileSync(databasePath, "");
      } else {
        const unrelated = new DatabaseSync(databasePath);
        unrelated.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY); PRAGMA user_version = 1;");
        unrelated.close();
      }

      assert.throws(
        () => new ScheduleStore(dir, { requireExistingDatabase: true }),
        /not a valid authoritative scheduler database/u,
      );

      const check = new DatabaseSync(databasePath, { readOnly: true });
      const tables = check
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all() as Array<{ readonly name: string }>;
      check.close();
      assert.deepEqual(
        tables.map((row) => row.name),
        fixture === "empty" ? [] : ["unrelated"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("requireExistingDatabase rejects unversioned scheduler tables and ledgers newer than this build", () => {
  const dir = tempDir();
  try {
    const databasePath = join(dir, "schedules.db");
    const unversioned = new DatabaseSync(databasePath);
    unversioned.exec(
      "CREATE TABLE schedules (id TEXT PRIMARY KEY); CREATE TABLE invocations (id TEXT PRIMARY KEY);",
    );
    unversioned.close();
    assert.throws(
      () => new ScheduleStore(dir, { requireExistingDatabase: true }),
      /not a valid authoritative scheduler database/u,
    );
    rmSync(databasePath, { force: true });

    const created = new ScheduleStore(dir);
    created.close();
    const bump = new DatabaseSync(databasePath);
    const current = bump.prepare("PRAGMA user_version").get() as { readonly user_version: number };
    bump.exec(`PRAGMA user_version = ${String(current.user_version + 1)}`);
    bump.close();
    assert.throws(() => new ScheduleStore(dir, { requireExistingDatabase: true }), /高于当前支持/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireExistingDatabase recovers a hot rollback journal left by a killed writer", () => {
  const source = tempDir();
  const copy = tempDir();
  try {
    const seed = new ScheduleStore(source);
    for (let index = 0; index < 40; index += 1) {
      seed.createSchedule(
        sampleInput({ name: `journal ${String(index)}`, prompt: "p".repeat(2_000) }),
        NOW,
      );
    }
    seed.close();
    const writer = new DatabaseSync(join(source, "schedules.db"));
    writer.exec("PRAGMA cache_size = 1; BEGIN IMMEDIATE;");
    writer.exec("UPDATE schedules SET prompt = prompt || 'x'");
    const journalPath = join(source, "schedules.db-journal");
    assert.equal(existsSync(journalPath), true);
    copyFileSync(join(source, "schedules.db"), join(copy, "schedules.db"));
    copyFileSync(journalPath, join(copy, "schedules.db-journal"));
    writer.exec("ROLLBACK");
    writer.close();

    const recovered = new ScheduleStore(copy, { requireExistingDatabase: true });
    const prompts = recovered.listSchedules().map((schedule) => schedule.prompt);
    assert.equal(prompts.length, 40);
    assert.equal(
      prompts.every((prompt) => prompt === "p".repeat(2_000)),
      true,
    );
    recovered.close();
    assert.equal(existsSync(join(copy, "schedules.db-journal")), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

test("requireExistingDatabase waits for a writer holding an exclusive lock instead of failing fast", async () => {
  const dir = tempDir();
  try {
    const seed = new ScheduleStore(dir);
    seed.close();
    const holder = [
      'import("node:sqlite").then(({ DatabaseSync }) => {',
      "  const db = new DatabaseSync(process.argv[1]);",
      '  db.exec("BEGIN EXCLUSIVE");',
      '  process.stdout.write("locked" + String.fromCharCode(10));',
      '  setTimeout(() => { db.exec("COMMIT"); db.close(); }, 700);',
      "});",
    ].join("");
    const child = spawn(
      process.execPath,
      ["--experimental-sqlite", "-e", holder, join(dir, "schedules.db")],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(child, "exit");
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("locked")) {
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`lock holder exited early (${String(code)})`)),
        );
      });
      const store = new ScheduleStore(dir, { requireExistingDatabase: true });
      try {
        assert.equal(store.listSchedules().length, 0);
      } finally {
        store.close();
      }
    } finally {
      await exited;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelInvocation 带正确 ownership token 时仍要求 running 行探活为 dead", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "alive" });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "daemon-1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.ok(
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
        pid: 5151,
        startToken: "pst-v2:alive",
      }),
    );
    assert.equal(
      store.cancelInvocation(claim.invocation.id, "still alive", NOW + 2, {
        expectedOwnershipToken: claim.ownershipToken,
      }),
      CANCEL_INVOCATION_OUTCOMES.executorAlive,
    );
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fireImmediately 让 nextRunAt 等于 now", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    assert.equal(created.nextRunAtMs, NOW);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause/resume 只改状态不改相位", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 1), true);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, NOW + 1_800_000);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.active, NOW + 2), true);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, NOW + 1_800_000);
    assert.equal(store.setScheduleStatus("missing", SCHEDULE_STATUSES.paused, NOW), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readScheduleLedger 只读三分支：不存在为空、版本不符拒读、正常返回列表且零写入", () => {
  const dir = tempDir();
  try {
    const missing = readScheduleLedger(join(dir, "missing"));
    assert.equal(missing.status, "empty");
    assert.deepEqual(missing.schedules, []);
    assert.equal(existsSync(join(dir, "missing")), false);

    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    store.close();

    const ok = readScheduleLedger(dir);
    assert.equal(ok.status, "ok");
    assert.equal(ok.schedules.length, 1);
    assert.equal(ok.schedules[0]?.id, created.id);

    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    const drifted = readScheduleLedger(dir);
    assert.equal(drifted.status, "migration-required");
    assert.equal(drifted.status === "migration-required" && drifted.schemaVersion, 99);
    assert.deepEqual(drifted.schedules, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createScheduleIdempotent 事务内语义查重：相同 active 定义返回既有任务", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const first = store.createScheduleIdempotent(sampleInput(), NOW);
    assert.equal(first.created, true);
    assert.equal(first.reauthorized, false);

    const replay = store.createScheduleIdempotent(sampleInput({ name: "另一个名字" }), NOW + 1);
    assert.equal(replay.created, false);
    assert.equal(replay.reauthorized, false);
    assert.equal(replay.schedule.id, first.schedule.id);
    assert.equal(store.listSchedules().length, 1);

    const differentTrigger = store.createScheduleIdempotent(
      sampleInput({ trigger: createIntervalTrigger("2h") }),
      NOW + 2,
    );
    assert.equal(differentTrigger.created, true);

    const differentMaxRun = store.createScheduleIdempotent(
      sampleInput({ maxRunMs: 120_000 }),
      NOW + 3,
    );
    assert.equal(differentMaxRun.created, true);

    store.setScheduleStatus(first.schedule.id, SCHEDULE_STATUSES.paused, NOW + 4);
    const afterPause = store.createScheduleIdempotent(sampleInput(), NOW + 5);
    assert.equal(afterPause.created, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createScheduleIdempotent 按有效 maxRun 查重：缺省与显式 1h 视为同一定义", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const implicit = store.createScheduleIdempotent(sampleInput(), NOW);
    assert.equal(implicit.created, true);

    const explicitOneHour = store.createScheduleIdempotent(
      sampleInput({ maxRunMs: 3_600_000 }),
      NOW + 1,
    );
    assert.equal(explicitOneHour.created, false);
    assert.equal(explicitOneHour.schedule.id, implicit.schedule.id);
    assert.equal(store.listSchedules().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createScheduleIdempotent 命中既有任务但权限摘要不同时按新摘要重新授权", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const first = store.createScheduleIdempotent(
      { ...sampleInput(), authorityDigest: "v1:old" },
      NOW,
    );
    assert.equal(first.created, true);

    const replay = store.createScheduleIdempotent(
      { ...sampleInput(), authorityDigest: "v1:new" },
      NOW + 1,
    );
    assert.equal(replay.created, false);
    assert.equal(replay.reauthorized, true);
    assert.equal(replay.schedule.id, first.schedule.id);
    assert.equal(replay.schedule.authorityDigest, "v1:new");
    assert.equal(store.getSchedule(first.schedule.id)?.authorityDigest, "v1:new");

    const same = store.createScheduleIdempotent(
      { ...sampleInput(), authorityDigest: "v1:new" },
      NOW + 2,
    );
    assert.equal(same.reauthorized, false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeSchedule 原子写入状态与授权摘要，任务不存在时返回 false", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 1);

    assert.equal(store.resumeSchedule(created.id, "v1:digest-next", NOW + 2), true);
    const resumed = store.getSchedule(created.id);
    assert.equal(resumed?.status, SCHEDULE_STATUSES.active);
    assert.equal(resumed?.authorityDigest, "v1:digest-next");
    assert.equal(resumed?.nextRunAtMs, NOW + 1_800_000);

    assert.equal(store.resumeSchedule("missing", "v1:digest-next", NOW + 3), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超过 maxSchedules、非法 name/prompt/cwd 都被拒绝", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { maxSchedules: 1 });
    store.createSchedule(sampleInput(), NOW);
    assert.throws(
      () => store.createSchedule(sampleInput({ name: "second" }), NOW),
      (error: unknown) =>
        error instanceof ScheduleStoreError &&
        error.code === SCHEDULE_STORE_ERROR_CODES.limitReached,
    );
    assert.throws(
      () => store.createSchedule(sampleInput({ name: "   " }), NOW),
      ScheduleStoreError,
    );
    assert.throws(
      () => store.createSchedule(sampleInput({ prompt: "x".repeat(4_001) }), NOW),
      ScheduleStoreError,
    );
    assert.throws(
      () => store.createSchedule(sampleInput({ cwd: "relative/path" }), NOW),
      ScheduleStoreError,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "ScheduleStore 在 POSIX 上收紧目录与数据库权限",
  { skip: process.platform === "win32" },
  () => {
    const parent = tempDir();
    const dir = join(parent, "nested", "scheduler");
    try {
      chmodSync(parent, 0o755);
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      const store = new ScheduleStore(dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, "schedules.db")).mode & 0o777, 0o600);
      store.close();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("claimDue 为到期 schedule 生成 invocation 并把 nextRunAt 从 now 重锚", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 120_000 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const late = NOW + 4 * 3_600_000;
    const claims = store.claimDue({ workerId: "w1", nowMs: late, limit: 5 });
    assert.equal(claims.length, 1);
    const claim = claims[0];
    assert.ok(claim);
    assert.equal(claim.invocation.status, INVOCATION_STATUSES.claimed);
    assert.equal(claim.invocation.mode, INVOCATION_MODES.scheduled);
    assert.equal(claim.invocation.scheduledForMs, NOW);
    assert.equal(claim.invocation.attempt, 1);
    assert.equal(claim.invocation.claimedBy, "w1");
    assert.equal(claim.invocation.leaseUntilMs, late + 120_000);
    assert.equal(claim.schedule.id, created.id);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, late + 1_800_000);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: late + 1, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimDue 尊重 limit，paused schedule 不触发", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const a = store.createSchedule(sampleInput({ name: "a", fireImmediately: true }), NOW);
    store.createSchedule(sampleInput({ name: "b", fireImmediately: true }), NOW);
    const c = store.createSchedule(sampleInput({ name: "c", fireImmediately: true }), NOW);
    store.setScheduleStatus(c.id, SCHEDULE_STATUSES.paused, NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.schedule.id, a.id);
    const second = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 5 });
    assert.equal(second.length, 1);
    assert.equal(second[0]?.schedule.name, "b");
    assert.deepEqual(store.claimDue({ workerId: "w1", nowMs: NOW, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("begin/renew/complete 都受 ownership token 约束", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(store.beginInvocation(claim.invocation.id, "wrong-token", NOW + 1), undefined);
    const begun = store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1);
    assert.equal(begun?.invocation.status, INVOCATION_STATUSES.running);
    assert.equal(begun?.invocation.startedAtMs, NOW + 1);
    assert.equal(store.renewLease(claim.invocation.id, "wrong-token", NOW + 2), false);
    assert.equal(store.renewLease(claim.invocation.id, claim.ownershipToken, NOW + 2), true);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: "wrong-token",
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 3,
      }),
      COMPLETE_INVOCATION_OUTCOMES.lostClaim,
    );
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.needsConfirmation,
        nowMs: NOW + 3,
        threadId: "thread-1",
        outputExcerpt: "done",
        pendingActions: ["browser.click"],
      }),
      COMPLETE_INVOCATION_OUTCOMES.written,
    );
    const stored = store.getInvocation(claim.invocation.id);
    assert.equal(stored?.status, INVOCATION_STATUSES.needsConfirmation);
    assert.equal(stored?.threadId, "thread-1");
    assert.deepEqual(stored?.pendingActions, ["browser.click"]);
    assert.equal(stored?.claimedBy, undefined);
    assert.equal(stored?.finishedAtMs, NOW + 3);
    assert.equal(store.getSchedule(created.id)?.lastRunAtMs, NOW + 3);
    assert.equal(store.getSchedule(created.id)?.lastError, undefined);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 4,
      }),
      COMPLETE_INVOCATION_OUTCOMES.lostClaim,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failInvocation 走退避重试，预算耗尽后终态并 pause scheduled 任务", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 2, retryBackoffMs: 10_000 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    assert.equal(
      store.failInvocation(first.invocation.id, "wrong", "boom", NOW + 1),
      INVOCATION_FAILURE_OUTCOMES.lostClaim,
    );
    assert.equal(
      store.failInvocation(first.invocation.id, first.ownershipToken, "boom", NOW + 1),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const afterFirst = store.getInvocation(first.invocation.id);
    assert.equal(afterFirst?.status, INVOCATION_STATUSES.retry);
    assert.equal(afterFirst?.retryAtMs, NOW + 10_001);
    assert.equal(afterFirst?.error, "boom");
    assert.deepEqual(store.claimDue({ workerId: "w1", nowMs: NOW + 5_000, limit: 5 }), []);
    const second = store.claimDue({ workerId: "w1", nowMs: NOW + 11_000, limit: 5 })[0];
    assert.ok(second);
    assert.equal(second.invocation.id, first.invocation.id);
    assert.equal(second.invocation.attempt, 2);
    assert.equal(
      store.failInvocation(second.invocation.id, second.ownershipToken, "boom again", NOW + 12_000),
      INVOCATION_FAILURE_OUTCOMES.terminalPaused,
    );
    assert.equal(store.getInvocation(first.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.match(store.getSchedule(created.id)?.lastError ?? "", /boom again/u);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease 过期的 claimed/running invocation 会被重新 claim 为同一次触发", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000, retryBudget: 3 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 500, limit: 5 }), []);
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 1_001, limit: 5 });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.invocation.id, first.invocation.id);
    assert.equal(reclaimed[0]?.invocation.attempt, 2);
    assert.equal(reclaimed[0]?.invocation.claimedBy, "w2");
    assert.notEqual(reclaimed[0]?.ownershipToken, first.ownershipToken);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 1_002), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual invocation 入队、单独 claim，失败不 pause 计划", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const created = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(created.id, NOW);
    assert.equal(queued.mode, INVOCATION_MODES.manual);
    assert.equal(queued.status, INVOCATION_STATUSES.pending);
    assert.throws(() => store.enqueueManualInvocation("missing", NOW), ScheduleStoreError);
    assert.equal(store.claimPendingInvocation(queued.id, "inline", NOW + 1)?.invocation.attempt, 1);
    assert.equal(store.claimPendingInvocation(queued.id, "inline", NOW + 1), undefined);
    const claimed = store.getInvocation(queued.id);
    assert.equal(claimed?.status, INVOCATION_STATUSES.claimed);
    assert.equal(claimed?.claimedBy, "inline");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual 失败终态不 pause 计划；listInvocations 与 nextWakeAtMs", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const created = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(created.id, NOW);
    assert.equal(store.nextWakeAtMs(), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW + 1, limit: 5 })[0];
    assert.ok(claim);
    assert.equal(claim.invocation.id, queued.id);
    assert.equal(
      store.failInvocation(claim.invocation.id, claim.ownershipToken, "manual boom", NOW + 2),
      INVOCATION_FAILURE_OUTCOMES.terminal,
    );
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.active);
    assert.equal(store.listInvocations(created.id).length, 1);
    assert.equal(store.listInvocations(created.id, 0).length, 0);
    assert.equal(store.nextWakeAtMs(), NOW + 1_800_000);
    store.removeSchedule(created.id);
    assert.equal(store.nextWakeAtMs(), undefined);
    assert.equal(store.listInvocations(created.id).length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running 且 executor 仍存活或未知时 lease 过期只续 lease，不重复执行；executor 已死才 reclaim", () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "dead" | "unknown" = "alive";
    const probed: number[] = [];
    const store = new ScheduleStore(dir, {
      claimLeaseMs: 1_000,
      executorLiveness: (executor) => {
        probed.push(executor.pid);
        return liveness;
      },
    });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW, {
      pid: 4242,
      startToken: "pst-v2:abc",
    });
    assert.deepEqual(store.getInvocation(first.invocation.id)?.executor, {
      pid: 4242,
      startToken: "pst-v2:abc",
    });
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 1_001, limit: 5 }), []);
    assert.deepEqual(probed, [4242]);
    assert.equal(store.getInvocation(first.invocation.id)?.leaseUntilMs, NOW + 2_001);
    assert.equal(store.getInvocation(first.invocation.id)?.status, INVOCATION_STATUSES.running);
    liveness = "unknown";
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 2_002, limit: 5 }), []);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 2_003), true);
    liveness = "dead";
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 3_100, limit: 5 });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.invocation.id, first.invocation.id);
    assert.equal(reclaimed[0]?.invocation.attempt, 2);
    assert.equal(reclaimed[0]?.invocation.status, INVOCATION_STATUSES.claimed);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 3_101), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没有注入探针时 running 行 lease 过期永不 reclaim（fail-closed）", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW, {
      pid: 1,
      startToken: "pst-v2:abc",
    });
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 60_000, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimed 但尚未 begin 的行 lease 过期照常 reclaim，旧 token 的 begin 被拒绝", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 1_001, limit: 5 });
    assert.equal(reclaimed[0]?.invocation.id, first.invocation.id);
    assert.equal(
      store.beginInvocation(first.invocation.id, first.ownershipToken, NOW + 1_002, {
        pid: 7,
        startToken: "pst-v2:late",
      }),
      undefined,
    );
    assert.equal(store.getInvocation(first.invocation.id)?.executor, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual invocation 可指定 maxAttempts=1 首次失败即终态；failInvocation terminal 选项跳过重试", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const single = store.enqueueManualInvocation(created.id, NOW, { maxAttempts: 1 });
    assert.equal(single.maxAttempts, 1);
    const claim = store.claimPendingInvocation(single.id, "inline", NOW + 1);
    assert.ok(claim);
    assert.equal(
      store.failInvocation(single.id, claim.ownershipToken, "LLM 未配置", NOW + 2),
      INVOCATION_FAILURE_OUTCOMES.terminal,
    );
    assert.equal(store.getInvocation(single.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.active);
    const scheduled = store.claimDue({ workerId: "w1", nowMs: NOW + 20, limit: 1 })[0];
    assert.ok(scheduled);
    assert.equal(scheduled.invocation.mode, INVOCATION_MODES.scheduled);
    assert.equal(scheduled.invocation.maxAttempts, 3);
    assert.equal(
      store.failInvocation(
        scheduled.invocation.id,
        scheduled.ownershipToken,
        "权限边界已变化",
        NOW + 21,
        { terminal: true },
      ),
      INVOCATION_FAILURE_OUTCOMES.terminalPaused,
    );
    assert.equal(store.getInvocation(scheduled.invocation.id)?.attempt, 1);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.equal(store.getSchedule(created.id)?.lastError, "权限边界已变化");
    assert.equal(store.enqueueManualInvocation(created.id, NOW + 30).maxAttempts, 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneInvocations 按每任务保留数与保留时长删除终态行，不动 live 行", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      invocationRetentionPerSchedule: 2,
      invocationRetentionMs: 100_000,
    });
    const created = store.createSchedule(sampleInput(), NOW);
    const finishAt = (offset: number) => {
      const queued = store.enqueueManualInvocation(created.id, NOW + offset);
      const claim = store.claimPendingInvocation(queued.id, "w", NOW + offset);
      assert.ok(claim);
      store.completeInvocation({
        id: queued.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + offset,
      });
      return queued.id;
    };
    const old = finishAt(0);
    const a = finishAt(1_000);
    const b = finishAt(2_000);
    const c = finishAt(3_000);
    const live = store.enqueueManualInvocation(created.id, NOW + 4_000);
    assert.equal(store.pruneInvocations(NOW + 100_500), 2);
    const remaining = store.listInvocations(created.id).map((row) => row.id);
    assert.deepEqual(new Set(remaining), new Set([b, c, live.id]));
    assert.ok(!remaining.includes(old) && !remaining.includes(a));
    assert.equal(store.pruneInvocations(NOW + 100_500), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorityDigest 随 schedule 保存并可通过 setAuthorityDigest 更新", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ authorityDigest: "sha256:aaa" }), NOW);
    assert.equal(created.authorityDigest, "sha256:aaa");
    assert.equal(store.createSchedule(sampleInput(), NOW).authorityDigest, undefined);
    assert.equal(store.setAuthorityDigest(created.id, "sha256:bbb", NOW + 1), true);
    assert.equal(store.getSchedule(created.id)?.authorityDigest, "sha256:bbb");
    assert.equal(store.getSchedule(created.id)?.updatedAtMs, NOW + 1);
    assert.equal(store.setAuthorityDigest("missing", "x", NOW), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("打开 schema v1 数据库时自动补齐新列并升级 user_version", () => {
  const dir = tempDir();
  try {
    const legacy = new DatabaseSync(join(dir, "schedules.db"));
    legacy.exec(
      `CREATE TABLE schedules (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
         trigger_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
         next_run_at INTEGER, last_run_at INTEGER, last_error TEXT,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE invocations (
         id TEXT PRIMARY KEY,
         schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
         mode TEXT NOT NULL, status TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
         attempt INTEGER NOT NULL DEFAULT 0, claimed_by TEXT, ownership_token TEXT,
         lease_until INTEGER, retry_at INTEGER, thread_id TEXT, output_excerpt TEXT, error TEXT,
         pending_actions_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
         started_at INTEGER, finished_at INTEGER, UNIQUE (schedule_id, mode, scheduled_for));
       INSERT INTO schedules VALUES ('s1', 'n', 'p', '/w', '{"kind":"interval","everyMs":60000}',
         'active', 1, NULL, NULL, 1, 1);
       INSERT INTO invocations (id, schedule_id, mode, status, scheduled_for, attempt, created_at)
         VALUES ('i1', 's1', 'manual', 'retry', 1, 1, 1);
       PRAGMA user_version = 1;`,
    );
    legacy.close();
    const store = new ScheduleStore(dir);
    assert.equal(store.getSchedule("s1")?.authorityDigest, undefined);
    const migrated = store.getInvocation("i1");
    assert.equal(migrated?.maxAttempts, 3);
    assert.equal(migrated?.executor, undefined);
    assert.deepEqual(migrated?.treeTrackedPgids, []);
    assert.equal(migrated?.treeUnsettled, false);
    assert.deepEqual(migrated?.treeSurvivorPids, []);
    store.close();
    const reopened = new DatabaseSync(join(dir, "schedules.db"));
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, 5);
    const columns = reopened.prepare("PRAGMA table_info(invocations)").all() as Array<{
      readonly name: string;
    }>;
    const columnNames = new Set(columns.map((column) => column.name));
    assert.equal(columnNames.has("tree_tracked_pgids"), true);
    assert.equal(columnNames.has("tree_unsettled"), true);
    assert.equal(columnNames.has("tree_survivor_pids"), true);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heldInvocationIds 里的 claimed/running 行 lease 过期只续租；limit<=0 时预扫描仍然续租", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "A", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    const held = new Set([first.invocation.id]);
    assert.deepEqual(
      store.claimDue({ workerId: "A", nowMs: NOW + 5_000, limit: 5, heldInvocationIds: held }),
      [],
    );
    assert.equal(store.getInvocation(first.invocation.id)?.leaseUntilMs, NOW + 6_000);
    assert.equal(store.getInvocation(first.invocation.id)?.attempt, 1);
    assert.deepEqual(
      store.claimDue({ workerId: "A", nowMs: NOW + 9_000, limit: 0, heldInvocationIds: held }),
      [],
    );
    assert.equal(store.getInvocation(first.invocation.id)?.leaseUntilMs, NOW + 10_000);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 9_001), true);
    const reclaimed = store.claimDue({ workerId: "B", nowMs: NOW + 12_000, limit: 5 });
    assert.equal(reclaimed[0]?.invocation.attempt, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause 会放弃 scheduled 模式的 retry 行，manual 行不受影响；暂停任务的过期 claim 不再重跑", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000, retryBudget: 3 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const scheduled = store.claimDue({ workerId: "w", nowMs: NOW, limit: 1 })[0];
    assert.ok(scheduled);
    assert.equal(
      store.failInvocation(scheduled.invocation.id, scheduled.ownershipToken, "boom", NOW + 1),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const manual = store.enqueueManualInvocation(created.id, NOW + 2);
    const manualClaim = store.claimPendingInvocation(manual.id, "w", NOW + 3);
    assert.ok(manualClaim);
    store.failInvocation(manual.id, manualClaim.ownershipToken, "manual boom", NOW + 4);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 5), true);
    assert.equal(store.getInvocation(scheduled.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.match(store.getInvocation(scheduled.invocation.id)?.error ?? "", /任务已暂停/u);
    assert.equal(store.getInvocation(manual.id)?.status, INVOCATION_STATUSES.retry);
    assert.equal(store.getSchedule(created.id)?.lastError, undefined);
    const second = store.claimDue({ workerId: "w", nowMs: NOW + 20_000, limit: 5 });
    assert.deepEqual(
      second.map((claim) => claim.invocation.id),
      [manual.id],
    );
    const manualAgain = second[0];
    assert.ok(manualAgain);
    assert.equal(
      store.failInvocation(manual.id, manualAgain.ownershipToken, "manual boom 2", NOW + 20_001, {
        terminal: true,
      }),
      INVOCATION_FAILURE_OUTCOMES.terminal,
    );
    store.setScheduleStatus(created.id, SCHEDULE_STATUSES.active, NOW + 20_002);
    const again = store.claimDue({ workerId: "w", nowMs: NOW + 1_900_000, limit: 5 })[0];
    assert.ok(again);
    assert.equal(again.invocation.mode, INVOCATION_MODES.scheduled);
    store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 1_900_001);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 1_902_000, limit: 5 }), []);
    assert.equal(store.getInvocation(again.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.match(store.getInvocation(again.invocation.id)?.error ?? "", /任务已暂停/u);
    assert.equal(store.getSchedule(created.id)?.lastError, "manual boom 2");
    assert.equal(store.nextWakeAtMs(), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v1 库中超过 365 天的 interval 在迁移时被钳位并暂停；损坏的 trigger 行只暂停自己", () => {
  const dir = tempDir();
  try {
    const legacy = new DatabaseSync(join(dir, "schedules.db"));
    legacy.exec(
      `CREATE TABLE schedules (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
         trigger_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
         next_run_at INTEGER, last_run_at INTEGER, last_error TEXT,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE invocations (
         id TEXT PRIMARY KEY,
         schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
         mode TEXT NOT NULL, status TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
         attempt INTEGER NOT NULL DEFAULT 0, claimed_by TEXT, ownership_token TEXT,
         lease_until INTEGER, retry_at INTEGER, thread_id TEXT, output_excerpt TEXT, error TEXT,
         pending_actions_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
         started_at INTEGER, finished_at INTEGER, UNIQUE (schedule_id, mode, scheduled_for));
       INSERT INTO schedules VALUES ('big', 'n', 'p', '/w', '{"kind":"interval","everyMs":86400000000000000}',
         'active', 1, NULL, NULL, 1, 1);
       INSERT INTO schedules VALUES ('ok', 'n', 'p', '/w', '{"kind":"interval","everyMs":60000}',
         'active', 1, NULL, NULL, 1, 1);
       PRAGMA user_version = 1;`,
    );
    legacy.close();
    const store = new ScheduleStore(dir);
    const big = store.getSchedule("big");
    assert.equal(big?.status, SCHEDULE_STATUSES.paused);
    assert.equal(big?.trigger.everyMs, 31_536_000_000);
    assert.match(big?.lastError ?? "", /365/u);
    assert.equal(store.listSchedules().length, 2);
    store.close();
    const corrupt = new DatabaseSync(join(dir, "schedules.db"));
    corrupt.exec(`UPDATE schedules SET trigger_json = '{"kind":"daily"}' WHERE id = 'ok';`);
    corrupt.close();
    const reopened = new ScheduleStore(dir);
    assert.deepEqual(reopened.claimDue({ workerId: "w", nowMs: NOW, limit: 5 }), []);
    reopened.close();
    const check = new DatabaseSync(join(dir, "schedules.db"));
    const row = check.prepare("SELECT status, last_error FROM schedules WHERE id = 'ok'").get() as {
      status: string;
      last_error: string;
    };
    assert.equal(row.status, "paused");
    assert.match(row.last_error, /无法解析/u);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRunningInvocations 只返回 running 行", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.deepEqual(store.listRunningInvocations(), []);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
      pid: 99,
      startToken: "pst-v2:x",
    });
    assert.deepEqual(
      store.listRunningInvocations().map((row) => [row.id, row.executor?.pid]),
      [[claim.invocation.id, 99]],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listOccupyingInvocations 与单例门禁一致：包含 claimed/running 和带未清树的 retry", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBackoffMs: 10_000 });
    const createManual = (name: string) => {
      const schedule = store.createSchedule(sampleInput({ name }), NOW);
      const queued = store.enqueueManualInvocation(schedule.id, NOW);
      return { schedule, queued };
    };

    const claimedSeed = createManual("claimed");
    const claimed = store.claimPendingInvocation(claimedSeed.queued.id, "w", NOW);
    assert.ok(claimed);

    const runningSeed = createManual("running");
    const running = store.claimPendingInvocation(runningSeed.queued.id, "w", NOW);
    assert.ok(running);
    store.beginInvocation(runningSeed.queued.id, running.ownershipToken, NOW, {
      pid: 4201,
      startToken: "pst-v2:running",
    });

    const treeRetrySeed = createManual("tree-retry");
    const treeRetry = store.claimPendingInvocation(treeRetrySeed.queued.id, "w", NOW);
    assert.ok(treeRetry);
    store.beginInvocation(treeRetrySeed.queued.id, treeRetry.ownershipToken, NOW, {
      pid: 4202,
      startToken: "pst-v2:tree-retry",
    });
    store.recordInvocationTree({
      id: treeRetrySeed.queued.id,
      ownershipToken: treeRetry.ownershipToken,
      trackedGroups: [{ pgid: 4202, leaderState: "alive", startToken: "pst-v2:tree-retry" }],
      unsettled: true,
      survivorPids: [4202],
    });
    store.failInvocation(treeRetrySeed.queued.id, treeRetry.ownershipToken, "tree retry", NOW);

    const plainRetrySeed = createManual("plain-retry");
    const plainRetry = store.claimPendingInvocation(plainRetrySeed.queued.id, "w", NOW);
    assert.ok(plainRetry);
    store.beginInvocation(plainRetrySeed.queued.id, plainRetry.ownershipToken, NOW);
    store.failInvocation(plainRetrySeed.queued.id, plainRetry.ownershipToken, "plain retry", NOW);

    createManual("pending");

    assert.equal(typeof store.listOccupyingInvocations, "function");
    assert.deepEqual(
      store
        .listOccupyingInvocations()
        .map((row) => row.id)
        .sort(),
      [claimedSeed.queued.id, runningSeed.queued.id, treeRetrySeed.queued.id].sort(),
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareWorkerShutdown 原子取消该 worker 的 claimed 并返回 running", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    store.createSchedule(sampleInput({ name: "worker claimed", fireImmediately: true }), NOW);
    store.createSchedule(sampleInput({ name: "worker running", fireImmediately: true }), NOW + 1);
    store.createSchedule(sampleInput({ name: "other worker", fireImmediately: true }), NOW + 2);
    const owned = store.claimDue({ workerId: "daemon-owned", nowMs: NOW + 2, limit: 2 });
    assert.equal(owned.length, 2);
    const [claimed, running] = owned;
    assert.ok(claimed);
    assert.ok(running);
    assert.ok(
      store.beginInvocation(running.invocation.id, running.ownershipToken, NOW + 3, {
        pid: 4242,
        startToken: "pst-v2:owned",
      }),
    );
    const other = store.claimDue({ workerId: "daemon-other", nowMs: NOW + 3, limit: 1 })[0];
    assert.ok(other);

    const liveRunning = store.prepareWorkerShutdown(
      "daemon-owned",
      "scheduler service stopped",
      NOW + 4,
    );

    assert.deepEqual(
      liveRunning.map((claim) => [
        claim.invocation.id,
        claim.invocation.executor?.pid,
        claim.ownershipToken,
      ]),
      [[running.invocation.id, 4242, running.ownershipToken]],
    );
    assert.equal(store.getInvocation(claimed.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getInvocation(claimed.invocation.id)?.claimedBy, undefined);
    assert.equal(store.getInvocation(claimed.invocation.id)?.leaseUntilMs, undefined);
    assert.equal(store.getInvocation(claimed.invocation.id)?.error, "scheduler service stopped");
    assert.equal(
      store.beginInvocation(claimed.invocation.id, claimed.ownershipToken, NOW + 5, {
        pid: 4343,
        startToken: "pst-v2:late",
      }),
      undefined,
    );
    assert.equal(store.getInvocation(running.invocation.id)?.status, INVOCATION_STATUSES.running);
    assert.equal(store.getInvocation(other.invocation.id)?.status, INVOCATION_STATUSES.claimed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一 schedule 同一时刻只有一次运行：manual 触发在运行中排队，inline claim 被拒绝", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const scheduled = store.claimDue({ workerId: "d", nowMs: NOW, limit: 5 })[0];
    assert.ok(scheduled);
    store.beginInvocation(scheduled.invocation.id, scheduled.ownershipToken, NOW + 1, {
      pid: 1,
      startToken: "pst-v2:a",
    });
    const first = store.enqueueManualInvocation(created.id, NOW + 2);
    const second = store.enqueueManualInvocation(created.id, NOW + 3);
    assert.equal(store.claimPendingInvocation(first.id, "inline", NOW + 4), undefined);
    assert.equal(store.getInvocation(first.id)?.status, INVOCATION_STATUSES.pending);
    assert.equal(store.findLiveRun(created.id)?.id, scheduled.invocation.id);
    assert.deepEqual(store.claimDue({ workerId: "d", nowMs: NOW + 5, limit: 5 }), []);
    assert.equal(store.discardPendingInvocation(first.id), true);
    assert.equal(store.discardPendingInvocation(first.id), false);
    store.completeInvocation({
      id: scheduled.invocation.id,
      ownershipToken: scheduled.ownershipToken,
      status: INVOCATION_STATUSES.completed,
      nowMs: NOW + 6,
    });
    assert.equal(store.findLiveRun(created.id), undefined);
    const claimedManual = store.claimDue({ workerId: "d", nowMs: NOW + 7, limit: 5 });
    assert.deepEqual(
      claimedManual.map((claim) => claim.invocation.id),
      [second.id],
    );
    const third = store.enqueueManualInvocation(created.id, NOW + 8);
    assert.equal(store.claimPendingInvocation(third.id, "inline", NOW + 9), undefined);
    assert.deepEqual(store.claimDue({ workerId: "d", nowMs: NOW + 10, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelInvocation：pending/claimed 直接取消；running 必须探活 dead，alive/unknown 拒绝，abandon 强制", () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "dead" | "unknown" = "alive";
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "d", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(
      store.cancelInvocation(claim.invocation.id, "取消未启动的 claim", NOW + 1),
      CANCEL_INVOCATION_OUTCOMES.cancelled,
    );
    assert.equal(
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 2, {
        pid: 1,
        startToken: "pst-v2:a",
      }),
      undefined,
    );
    assert.equal(
      store.cancelInvocation(claim.invocation.id, "again", NOW + 3),
      CANCEL_INVOCATION_OUTCOMES.terminal,
    );
    assert.equal(
      store.cancelInvocation("missing", "x", NOW + 3),
      CANCEL_INVOCATION_OUTCOMES.notFound,
    );

    const queued = store.enqueueManualInvocation(created.id, NOW + 4);
    assert.equal(
      store.cancelInvocation(queued.id, "取消排队", NOW + 5),
      CANCEL_INVOCATION_OUTCOMES.cancelled,
    );
    assert.equal(store.getInvocation(queued.id)?.status, INVOCATION_STATUSES.failed);

    const running = store.enqueueManualInvocation(created.id, NOW + 6);
    const runningClaim = store.claimPendingInvocation(running.id, "inline", NOW + 7);
    assert.ok(runningClaim);
    store.beginInvocation(running.id, runningClaim.ownershipToken, NOW + 8, {
      pid: 4242,
      startToken: "pst-v2:b",
    });
    assert.equal(
      store.cancelInvocation(running.id, "cancel", NOW + 9),
      CANCEL_INVOCATION_OUTCOMES.executorAlive,
    );
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    liveness = "unknown";
    assert.equal(
      store.cancelInvocation(running.id, "cancel", NOW + 10),
      CANCEL_INVOCATION_OUTCOMES.executorUnknown,
    );
    assert.equal(store.findLiveRun(created.id)?.id, running.id);
    liveness = "dead";
    assert.equal(
      store.cancelInvocation(running.id, "stale worker cleanup", NOW + 11, {
        expectedOwnershipToken: "stale-token",
      }),
      CANCEL_INVOCATION_OUTCOMES.ownershipChanged,
    );
    assert.equal(store.getInvocation(running.id)?.status, INVOCATION_STATUSES.running);
    assert.equal(
      store.cancelInvocation(running.id, "已确认退出", NOW + 12, {
        expectedOwnershipToken: runningClaim.ownershipToken,
      }),
      CANCEL_INVOCATION_OUTCOMES.cancelled,
    );
    assert.equal(
      store.completeInvocation({
        id: running.id,
        ownershipToken: runningClaim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 13,
      }),
      COMPLETE_INVOCATION_OUTCOMES.lostClaim,
    );
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.active);
    assert.equal(store.getSchedule(created.id)?.lastError, undefined);

    const abandoned = store.enqueueManualInvocation(created.id, NOW + 13);
    const abandonedClaim = store.claimPendingInvocation(abandoned.id, "inline", NOW + 14);
    assert.ok(abandonedClaim);
    store.beginInvocation(abandoned.id, abandonedClaim.ownershipToken, NOW + 15, {
      pid: 4343,
      startToken: "pst-v2:c",
    });
    liveness = "unknown";
    assert.equal(
      store.cancelInvocation(abandoned.id, "abandon", NOW + 16, { abandon: true }),
      CANCEL_INVOCATION_OUTCOMES.cancelled,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("探活为 descendants-alive 时视同存活：不 reclaim、cancel 要求 --kill", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, {
      claimLeaseMs: 1_000,
      executorLiveness: () => "descendants-alive",
    });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "d", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
      pid: 4242,
      startToken: "pst-v2:root-gone",
    });
    assert.deepEqual(store.claimDue({ workerId: "d2", nowMs: NOW + 5_000, limit: 5 }), []);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    assert.equal(
      store.cancelInvocation(claim.invocation.id, "cancel", NOW + 6_000),
      CANCEL_INVOCATION_OUTCOMES.executorAlive,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conditional cancel 拒绝收尾已被新 worker reclaim 的 invocation", () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "dead" = "dead";
    const store = new ScheduleStore(dir, {
      claimLeaseMs: 1,
      executorLiveness: () => liveness,
    });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const oldClaim = store.claimDue({ workerId: "daemon-old", nowMs: NOW, limit: 1 })[0];
    assert.ok(oldClaim);
    assert.ok(
      store.beginInvocation(oldClaim.invocation.id, oldClaim.ownershipToken, NOW, {
        pid: 4747,
        startToken: "pst-v2:old",
      }),
    );
    const newClaim = store.claimDue({ workerId: "daemon-new", nowMs: NOW + 2, limit: 1 })[0];
    assert.ok(newClaim);
    assert.notEqual(newClaim.ownershipToken, oldClaim.ownershipToken);
    liveness = "alive";
    assert.ok(
      store.beginInvocation(newClaim.invocation.id, newClaim.ownershipToken, NOW + 3, {
        pid: 4848,
        startToken: "pst-v2:new",
      }),
    );

    assert.equal(
      store.cancelInvocation(oldClaim.invocation.id, "stale shutdown", NOW + 4, {
        expectedOwnershipToken: oldClaim.ownershipToken,
      }),
      CANCEL_INVOCATION_OUTCOMES.ownershipChanged,
    );
    const current = store.getInvocation(oldClaim.invocation.id);
    assert.equal(current?.status, INVOCATION_STATUSES.running);
    assert.equal(current?.claimedBy, "daemon-new");
    assert.deepEqual(current?.executor, { pid: 4848, startToken: "pst-v2:new" });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordInvocationTree 在 retry 时保留登记组；终态出口在树未 settled 时 fail-closed", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 2, retryBackoffMs: 10_000 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW + 1, {
      pid: 4242,
      startToken: "pst-v2:tree",
    });
    assert.equal(
      store.recordInvocationTree({
        id: first.invocation.id,
        ownershipToken: first.ownershipToken,
        trackedGroups: [
          { pgid: 600, leaderState: "unknown" },
          { pgid: 601, leaderState: "unknown" },
        ],
        unsettled: true,
        survivorPids: [701],
      }),
      true,
    );
    assert.equal(
      store.failInvocation(first.invocation.id, first.ownershipToken, "boom", NOW + 2),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const retried = store.getInvocation(first.invocation.id);
    assert.equal(retried?.status, INVOCATION_STATUSES.retry);
    assert.deepEqual(retried?.treeTrackedPgids, [600, 601]);
    assert.equal(retried?.treeUnsettled, true);
    assert.deepEqual(retried?.treeSurvivorPids, [701]);
    const second = store.claimDue({ workerId: "w1", nowMs: NOW + 12_000, limit: 1 })[0];
    assert.ok(second);
    store.beginInvocation(second.invocation.id, second.ownershipToken, NOW + 12_001, {
      pid: 4343,
      startToken: "pst-v2:tree-2",
    });
    assert.equal(
      store.recordInvocationTree({
        id: second.invocation.id,
        ownershipToken: second.ownershipToken,
        trackedGroups: [{ pgid: 600, leaderState: "unknown" }],
        unsettled: true,
        survivorPids: [701],
      }),
      true,
    );
    assert.equal(
      store.failInvocation(
        second.invocation.id,
        second.ownershipToken,
        "still boom",
        NOW + 12_002,
        {
          terminal: true,
        },
      ),
      INVOCATION_FAILURE_OUTCOMES.treeUnsettled,
    );
    const blocked = store.getInvocation(second.invocation.id);
    assert.equal(blocked?.status, INVOCATION_STATUSES.running);
    assert.equal(store.getSchedule(second.schedule.id)?.status, SCHEDULE_STATUSES.active);
    assert.equal(
      store.completeInvocation({
        id: second.invocation.id,
        ownershipToken: second.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 12_003,
      }),
      COMPLETE_INVOCATION_OUTCOMES.treeUnsettled,
    );
    assert.equal(store.getInvocation(second.invocation.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel：exec 已死但持久化树未清时拒绝；probe settled 后才能 cancelled", () => {
  const dir = tempDir();
  try {
    let tree: typeof INVOCATION_TREE_LIVENESS.unsettled | typeof INVOCATION_TREE_LIVENESS.settled =
      INVOCATION_TREE_LIVENESS.unsettled;
    const store = new ScheduleStore(dir, {
      executorLiveness: () => "dead",
      treeLiveness: () => tree,
    });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "d", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
      pid: 4242,
      startToken: "pst-v2:dead",
    });
    assert.equal(
      store.recordInvocationTree({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        trackedGroups: [{ pgid: 9001, leaderState: "unknown" }],
        unsettled: true,
        survivorPids: [9002],
      }),
      true,
    );
    assert.equal(
      store.cancelInvocation(claim.invocation.id, "cancel", NOW + 2),
      CANCEL_INVOCATION_OUTCOMES.treeUnsettled,
    );
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    tree = INVOCATION_TREE_LIVENESS.settled;
    assert.equal(
      store.cancelInvocation(claim.invocation.id, "cancel after teardown", NOW + 3),
      CANCEL_INVOCATION_OUTCOMES.cancelled,
    );
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.active);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ScheduleStore：treeLiveness unavailable 时终态写入失败，行保持 running 并占单例", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, {
      executorLiveness: () => "dead",
      treeLiveness: () => INVOCATION_TREE_LIVENESS.unavailable,
    });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
      pid: 4242,
      startToken: "pst-v2:unverified",
    });
    assert.equal(
      store.recordInvocationTree({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        trackedGroups: [{ pgid: 600, leaderState: "alive" }],
        unsettled: true,
        survivorPids: [600],
      }),
      true,
    );
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 2,
      }),
      COMPLETE_INVOCATION_OUTCOMES.treeUnsettled,
    );
    assert.equal(
      store.failInvocation(claim.invocation.id, claim.ownershipToken, "x", NOW + 3, {
        terminal: true,
      }),
      INVOCATION_FAILURE_OUTCOMES.treeUnsettled,
    );
    assert.equal(
      store.cancelInvocation(claim.invocation.id, "cancel", NOW + 4),
      CANCEL_INVOCATION_OUTCOMES.treeUnsettled,
    );
    const held = store.getInvocation(claim.invocation.id);
    assert.equal(held?.status, INVOCATION_STATUSES.running);
    assert.equal(held?.treeUnsettled, true);
    assert.equal(store.findLiveRun(created.id)?.id, claim.invocation.id);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 5, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺省 treeLiveness 时非空树 fail-closed；空列不调用 probe", () => {
  const dir = tempDir();
  try {
    let probes = 0;
    const store = new ScheduleStore(dir, {
      treeLiveness: () => {
        probes += 1;
        return INVOCATION_TREE_LIVENESS.settled;
      },
    });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 2,
      }),
      COMPLETE_INVOCATION_OUTCOMES.written,
    );
    assert.equal(probes, 0);
    store.close();

    const blocked = new ScheduleStore(dir);
    const next = blocked.createSchedule(
      sampleInput({ name: "另一条", fireImmediately: true }),
      NOW + 3,
    );
    const nextClaim = blocked.claimDue({ workerId: "w2", nowMs: NOW + 3, limit: 1 })[0];
    assert.ok(nextClaim);
    blocked.beginInvocation(nextClaim.invocation.id, nextClaim.ownershipToken, NOW + 4);
    assert.equal(
      blocked.recordInvocationTree({
        id: nextClaim.invocation.id,
        ownershipToken: nextClaim.ownershipToken,
        trackedGroups: [{ pgid: 42, leaderState: "unknown" }],
        unsettled: true,
      }),
      true,
    );
    assert.equal(
      blocked.failInvocation(nextClaim.invocation.id, nextClaim.ownershipToken, "x", NOW + 5, {
        terminal: true,
      }),
      INVOCATION_FAILURE_OUTCOMES.treeUnsettled,
    );
    assert.equal(
      blocked.getInvocation(nextClaim.invocation.id)?.status,
      INVOCATION_STATUSES.running,
    );
    assert.equal(blocked.getSchedule(next.id)?.status, SCHEDULE_STATUSES.active);
    blocked.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ScheduleStore：身份未知的登记组与账本数字数组不得写成 leader 已退出", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1);
    assert.equal(
      store.recordInvocationTree({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        trackedGroups: [{ pgid: 700, leaderState: "unknown" }],
        unsettled: true,
      }),
      true,
    );
    assert.deepEqual(store.getInvocation(claim.invocation.id)?.treeTrackedGroups, [
      { pgid: 700, leaderState: "unknown" },
    ]);
    store.close();

    const db = new DatabaseSync(join(dir, "schedules.db"));
    db.prepare(`UPDATE invocations SET tree_tracked_pgids = ? WHERE id = ?`).run(
      "[700]",
      claim.invocation.id,
    );
    db.close();
    const reopened = new ScheduleStore(dir);
    assert.deepEqual(reopened.getInvocation(claim.invocation.id)?.treeTrackedGroups, [
      { pgid: 700, leaderState: "unknown" },
    ]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法或旧版 tree ownership 元数据不得被终态 writer 清洗，abandon 仍可强制收口", () => {
  const fixtures = [
    ["旧 leaderExited 对象", '[{"pgid":700,"leaderExited":true}]'],
    ["损坏 JSON", "not-json"],
    ["非数组 JSON", "{}"],
    ["含无效成员", "[{}]"],
  ] as const;

  for (const [label, treeJson] of fixtures) {
    const dir = tempDir();
    let reopened: ScheduleStore | undefined;
    try {
      const initial = new ScheduleStore(dir);
      initial.createSchedule(sampleInput({ name: label, fireImmediately: true }), NOW);
      const claim = initial.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
      assert.ok(claim);
      initial.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
        pid: 4242,
        startToken: "pst-v2:invalid-tree",
      });
      initial.close();

      const raw = new DatabaseSync(join(dir, "schedules.db"));
      raw
        .prepare(
          `UPDATE invocations
              SET tree_tracked_pgids = ?, tree_unsettled = 1, tree_survivor_pids = '[700]'
            WHERE id = ?`,
        )
        .run(treeJson, claim.invocation.id);
      raw.close();

      let probes = 0;
      reopened = new ScheduleStore(dir, {
        executorLiveness: () => "dead",
        treeLiveness: () => {
          probes += 1;
          return INVOCATION_TREE_LIVENESS.settled;
        },
      });
      assert.throws(
        () => reopened?.getInvocation(claim.invocation.id),
        /进程树所有权元数据无效/u,
        label,
      );
      assert.equal(
        reopened.completeInvocation({
          id: claim.invocation.id,
          ownershipToken: claim.ownershipToken,
          status: INVOCATION_STATUSES.completed,
          nowMs: NOW + 2,
        }),
        COMPLETE_INVOCATION_OUTCOMES.treeUnsettled,
        label,
      );
      assert.equal(
        reopened.failInvocation(claim.invocation.id, claim.ownershipToken, "failed", NOW + 3, {
          terminal: true,
        }),
        INVOCATION_FAILURE_OUTCOMES.treeUnsettled,
        label,
      );
      assert.equal(
        reopened.cancelInvocation(claim.invocation.id, "cancel", NOW + 4),
        CANCEL_INVOCATION_OUTCOMES.treeUnsettled,
        label,
      );
      assert.equal(
        reopened.finalizeCancellation({
          id: claim.invocation.id,
          reason: "cancel after teardown",
          nowMs: NOW + 5,
          expectedAttempt: claim.invocation.attempt,
          tree: { trackedGroups: [], unsettled: false, survivorPids: [] },
        }),
        CANCEL_INVOCATION_OUTCOMES.treeUnsettled,
        label,
      );
      assert.equal(probes, 0, label);

      const inspect = new DatabaseSync(join(dir, "schedules.db"));
      const held = inspect
        .prepare("SELECT status, tree_unsettled FROM invocations WHERE id = ?")
        .get(claim.invocation.id) as { readonly status: string; readonly tree_unsettled: number };
      inspect.close();
      assert.equal(held.status, INVOCATION_STATUSES.running, label);
      assert.equal(held.tree_unsettled, 1, label);
      assert.equal(
        reopened.cancelInvocation(claim.invocation.id, "abandon", NOW + 6, { abandon: true }),
        CANCEL_INVOCATION_OUTCOMES.cancelled,
        label,
      );
      reopened.close();
      reopened = undefined;
    } finally {
      reopened?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("非法 tree ownership 元数据只隔离所属任务，不阻塞其他到期任务", () => {
  const dir = tempDir();
  try {
    const initial = new ScheduleStore(dir, { retryBackoffMs: 1 });
    const created = initial.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = initial.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    initial.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1);
    assert.equal(
      initial.failInvocation(claim.invocation.id, claim.ownershipToken, "retry", NOW + 2),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    initial.close();

    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw
      .prepare(
        `UPDATE invocations
            SET tree_tracked_pgids = '{}', tree_unsettled = 0, retry_at = ?
          WHERE id = ?`,
      )
      .run(NOW + 3, claim.invocation.id);
    raw.close();

    const reopened = new ScheduleStore(dir);
    const manual = reopened.enqueueManualInvocation(created.id, NOW + 4);
    assert.equal(reopened.claimPendingInvocation(manual.id, "inline", NOW + 4), undefined);
    const healthy = reopened.createSchedule(
      sampleInput({ name: "健康任务", fireImmediately: true }),
      NOW + 4,
    );
    const claimed = reopened.claimDue({ workerId: "w2", nowMs: NOW + 4, limit: 5 });
    assert.deepEqual(
      claimed.map((item) => item.schedule.id),
      [healthy.id],
    );

    const inspect = new DatabaseSync(join(dir, "schedules.db"));
    const rows = inspect
      .prepare("SELECT id, status FROM invocations WHERE schedule_id = ? ORDER BY created_at")
      .all(created.id) as Array<{ readonly id: string; readonly status: string }>;
    inspect.close();
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, status: row.status })),
      [
        { id: claim.invocation.id, status: INVOCATION_STATUSES.retry },
        { id: manual.id, status: INVOCATION_STATUSES.pending },
      ],
    );
    assert.throws(
      () => reopened.removeSchedule(created.id),
      (error: unknown) =>
        error instanceof ScheduleStoreError &&
        error.code === SCHEDULE_STORE_ERROR_CODES.invalid &&
        /未结束/u.test(error.message),
    );
    assert.equal(reopened.removeSchedule(created.id, { abandon: true }), true);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function occupyRetryWithTree(store: ScheduleStore, nowMs: number) {
  const created = store.createSchedule(sampleInput({ fireImmediately: true }), nowMs);
  const claim = store.claimDue({ workerId: "w1", nowMs, limit: 1 })[0];
  assert.ok(claim);
  store.beginInvocation(claim.invocation.id, claim.ownershipToken, nowMs + 1, {
    pid: 4242,
    startToken: "pst-v2:retry-tree",
  });
  assert.equal(
    store.recordInvocationTree({
      id: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      trackedGroups: [{ pgid: 600, leaderState: "alive", startToken: "pst-v2:live-leader" }],
      unsettled: true,
      survivorPids: [600],
    }),
    true,
  );
  assert.equal(
    store.failInvocation(claim.invocation.id, claim.ownershipToken, "boom", nowMs + 2),
    INVOCATION_FAILURE_OUTCOMES.retryScheduled,
  );
  return { created, claim };
}

test("retry + 未清树占同 schedule 单例：manual claim / findLiveRun / claimDue 都被挡住", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3, retryBackoffMs: 10_000 });
    const { created, claim } = occupyRetryWithTree(store, NOW);
    const retried = store.getInvocation(claim.invocation.id);
    assert.equal(retried?.status, INVOCATION_STATUSES.retry);
    assert.equal(retried?.treeUnsettled, true);
    assert.equal(store.findLiveRun(created.id)?.id, claim.invocation.id);

    const queued = store.enqueueManualInvocation(created.id, NOW + 3);
    assert.equal(store.claimPendingInvocation(queued.id, "inline", NOW + 4), undefined);
    assert.equal(store.getInvocation(queued.id)?.status, INVOCATION_STATUSES.pending);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 5, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause 只停后续触发：未清树的 retry 保持 unsettled，空树 retry 仍放弃", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3, retryBackoffMs: 10_000 });
    const { created, claim } = occupyRetryWithTree(store, NOW);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 3), true);
    const held = store.getInvocation(claim.invocation.id);
    assert.equal(held?.status, INVOCATION_STATUSES.retry);
    assert.equal(held?.treeUnsettled, true);
    assert.deepEqual(held?.treeTrackedGroups, [
      { pgid: 600, leaderState: "alive", startToken: "pst-v2:live-leader" },
    ]);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);

    const clean = store.createSchedule(
      sampleInput({ name: "空树 retry", fireImmediately: true }),
      NOW + 4,
    );
    const cleanClaim = store.claimDue({ workerId: "w", nowMs: NOW + 4, limit: 1 })[0];
    assert.ok(cleanClaim);
    assert.equal(
      store.failInvocation(cleanClaim.invocation.id, cleanClaim.ownershipToken, "boom", NOW + 5),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    assert.equal(store.setScheduleStatus(clean.id, SCHEDULE_STATUSES.paused, NOW + 6), true);
    assert.equal(store.getInvocation(cleanClaim.invocation.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove 拒绝 live/未清树的 schedule，除非显式 abandon", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const { created, claim } = occupyRetryWithTree(store, NOW);
    assert.throws(
      () => store.removeSchedule(created.id),
      (error: unknown) =>
        error instanceof ScheduleStoreError &&
        error.code === SCHEDULE_STORE_ERROR_CODES.invalid &&
        /未结束|未清/u.test(error.message),
    );
    assert.equal(store.getSchedule(created.id)?.id, created.id);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.retry);
    assert.equal(store.removeSchedule(created.id, { abandon: true }), true);
    assert.equal(store.getSchedule(created.id), undefined);
    assert.equal(store.getInvocation(claim.invocation.id), undefined);

    const idle = store.createSchedule(sampleInput({ name: "空闲" }), NOW + 3);
    assert.equal(store.removeSchedule(idle.id), true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("旧 token 的 tree write 在 reclaim 后失效；stale cancel 不能取消新 owner", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, {
      claimLeaseMs: 1,
      executorLiveness: () => "dead",
      retryBudget: 3,
    });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const oldClaim = store.claimDue({ workerId: "A", nowMs: NOW, limit: 1 })[0];
    assert.ok(oldClaim);
    store.beginInvocation(oldClaim.invocation.id, oldClaim.ownershipToken, NOW + 1, {
      pid: 4747,
      startToken: "pst-v2:old",
    });
    assert.equal(
      store.recordInvocationTree({
        id: oldClaim.invocation.id,
        ownershipToken: oldClaim.ownershipToken,
        trackedGroups: [{ pgid: 600, leaderState: "unknown" }],
        unsettled: true,
        survivorPids: [600],
      }),
      true,
    );
    const beforeReclaim = store.getInvocation(oldClaim.invocation.id);
    assert.equal(beforeReclaim?.treeUnsettled, true);
    assert.deepEqual(beforeReclaim?.treeTrackedPgids, [600]);

    const newClaim = store.claimDue({ workerId: "B", nowMs: NOW + 3, limit: 1 })[0];
    assert.ok(newClaim);
    assert.notEqual(newClaim.ownershipToken, oldClaim.ownershipToken);
    assert.equal(newClaim.invocation.attempt, 2);
    assert.equal(
      store.recordInvocationTree({
        id: oldClaim.invocation.id,
        ownershipToken: oldClaim.ownershipToken,
        trackedGroups: [],
        unsettled: false,
      }),
      false,
    );
    assert.equal(store.getInvocation(oldClaim.invocation.id)?.treeUnsettled, true);
    assert.equal(
      store.finalizeCancellation({
        id: oldClaim.invocation.id,
        reason: "stale cancel",
        nowMs: NOW + 4,
        expectedAttempt: oldClaim.invocation.attempt,
        expectedClaimedBy: "A",
        tree: { trackedGroups: [], unsettled: false, survivorPids: [] },
      }),
      CANCEL_INVOCATION_OUTCOMES.ownershipChanged,
    );
    const current = store.getInvocation(oldClaim.invocation.id);
    assert.equal(current?.status, INVOCATION_STATUSES.claimed);
    assert.equal(current?.claimedBy, "B");
    assert.equal(current?.treeUnsettled, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalizeCancellation：pending 行不持有进程树，带 tree 的取消直接置终态；终态行返回 terminal", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { treeLiveness: () => "settled" });
    const schedule = store.createSchedule(sampleInput(), NOW);
    const pending = store.enqueueManualInvocation(schedule.id, NOW);
    assert.equal(pending.status, INVOCATION_STATUSES.pending);
    const finalize = () =>
      store.finalizeCancellation({
        id: pending.id,
        reason: "已由用户取消",
        nowMs: NOW + 1,
        expectedAttempt: pending.attempt,
        tree: { trackedGroups: [], unsettled: false, survivorPids: [] },
      });
    assert.equal(finalize(), CANCEL_INVOCATION_OUTCOMES.cancelled);
    assert.equal(store.getInvocation(pending.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(finalize(), CANCEL_INVOCATION_OUTCOMES.terminal);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordInvocationTree 可附带 error 文案写进 running 行；不传时保留原 error", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
      pid: 4747,
      startToken: "pst-v2:x",
    });
    assert.equal(
      store.recordInvocationTree({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        trackedGroups: [{ pgid: 600, leaderState: "alive", startToken: "pst-v2:l" }],
        unsettled: true,
        survivorPids: [601],
        error: "本次运行拉起的进程在强制终止后仍存活（pid 601）",
      }),
      true,
    );
    let record = store.getInvocation(claim.invocation.id);
    assert.equal(record?.status, INVOCATION_STATUSES.running);
    assert.equal(record?.error, "本次运行拉起的进程在强制终止后仍存活（pid 601）");
    assert.equal(
      store.recordInvocationTree({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        trackedGroups: [{ pgid: 600, leaderState: "alive", startToken: "pst-v2:l" }],
        unsettled: true,
        survivorPids: [601],
      }),
      true,
    );
    record = store.getInvocation(claim.invocation.id);
    assert.equal(record?.error, "本次运行拉起的进程在强制终止后仍存活（pid 601）");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimDue：paused 任务的未清树 retry 行只探一次就推迟 retry_at，不再每轮重探", () => {
  const dir = tempDir();
  try {
    let probes = 0;
    const store = new ScheduleStore(dir, {
      retryBudget: 3,
      retryBackoffMs: 1,
      claimLeaseMs: 1_000,
      treeLiveness: () => {
        probes += 1;
        return INVOCATION_TREE_LIVENESS.unsettled;
      },
    });
    const { created, claim } = occupyRetryWithTree(store, NOW);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 3), true);
    const afterPause = probes;
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.retry);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 10, limit: 5 }), []);
    assert.equal(probes, afterPause + 1);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 20, limit: 5 }), []);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 30, limit: 5 }), []);
    assert.equal(probes, afterPause + 1, "retry_at 推迟后到期前不得重探");
    const held = store.getInvocation(claim.invocation.id);
    assert.equal(held?.status, INVOCATION_STATUSES.retry);
    assert.equal(held?.treeUnsettled, true);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 10 + 1_001, limit: 5 }), []);
    assert.equal(probes, afterPause + 2, "推迟到期后再探一次");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏的 tree_survivor_pids 只当空列表，不阻塞其他任务 claim；损坏的 tree_tracked_pgids 错误里带 invocation id", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, {
      retryBudget: 3,
      retryBackoffMs: 1,
      treeLiveness: () => INVOCATION_TREE_LIVENESS.unsettled,
    });
    const { claim } = occupyRetryWithTree(store, NOW);
    const healthy = store.createSchedule(
      sampleInput({ name: "healthy", fireImmediately: true }),
      NOW + 5,
    );
    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw
      .prepare("UPDATE invocations SET tree_survivor_pids = 'oops' WHERE id = ?")
      .run(claim.invocation.id);
    raw.close();
    const claimed = store.claimDue({ workerId: "w2", nowMs: NOW + 10, limit: 5 });
    assert.ok(
      claimed.some((entry) => entry.schedule.id === healthy.id),
      "健康任务必须照常被 claim",
    );
    assert.deepEqual(store.getInvocation(claim.invocation.id)?.treeSurvivorPids, []);
    const corrupt = new DatabaseSync(join(dir, "schedules.db"));
    corrupt
      .prepare("UPDATE invocations SET tree_tracked_pgids = 'not-json' WHERE id = ?")
      .run(claim.invocation.id);
    corrupt.close();
    assert.throws(
      () => store.getInvocation(claim.invocation.id),
      (error: unknown) =>
        error instanceof ScheduleStoreError &&
        error.code === SCHEDULE_STORE_ERROR_CODES.invalid &&
        error.message.includes(claim.invocation.id),
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalizeCancellation：exec 仍存活时先拒绝，不把 CLI 的空树写到 exec 拥有的行上", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, {
      executorLiveness: () => "alive",
      treeLiveness: () => INVOCATION_TREE_LIVENESS.settled,
    });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
      pid: 4242,
      startToken: "pst-v2:alive",
    });
    const groups = [{ pgid: 600, leaderState: "alive" as const, startToken: "pst-v2:leader" }];
    assert.equal(
      store.recordInvocationTree({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        trackedGroups: groups,
        unsettled: true,
        survivorPids: [601],
      }),
      true,
    );
    assert.equal(
      store.finalizeCancellation({
        id: claim.invocation.id,
        reason: "已由用户取消",
        nowMs: NOW + 2,
        expectedAttempt: claim.invocation.attempt,
        tree: { trackedGroups: [], unsettled: false, survivorPids: [] },
      }),
      CANCEL_INVOCATION_OUTCOMES.executorAlive,
    );
    const record = store.getInvocation(claim.invocation.id);
    assert.equal(record?.status, INVOCATION_STATUSES.running);
    assert.equal(record?.treeUnsettled, true);
    assert.deepEqual(record?.treeSurvivorPids, [601]);
    assert.deepEqual(record?.treeTrackedGroups, groups);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareWorkerShutdown 对带未清树的 claimed 行不写终态", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3, retryBackoffMs: 1 });
    const { claim } = occupyRetryWithTree(store, NOW);
    const reclaimed = store.claimDue({
      workerId: "daemon-owned",
      nowMs: NOW + 20_000,
      limit: 1,
    })[0];
    assert.ok(reclaimed);
    assert.equal(reclaimed.invocation.id, claim.invocation.id);
    assert.equal(reclaimed.invocation.status, INVOCATION_STATUSES.claimed);
    assert.equal(reclaimed.invocation.treeUnsettled, true);

    const liveRunning = store.prepareWorkerShutdown(
      "daemon-owned",
      "scheduler service stopped",
      NOW + 20_001,
    );
    assert.deepEqual(liveRunning, []);
    const held = store.getInvocation(claim.invocation.id);
    assert.equal(held?.status, INVOCATION_STATUSES.claimed);
    assert.equal(held?.treeUnsettled, true);
    assert.equal(held?.claimedBy, "daemon-owned");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createSchedule 记录按任务的单次运行上限 maxRunMs，缺省为 undefined", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const capped = store.createSchedule(sampleInput({ maxRunMs: 7_200_000 }), NOW);
    assert.equal(capped.maxRunMs, 7_200_000);
    assert.equal(store.getSchedule(capped.id)?.maxRunMs, 7_200_000);
    const plain = store.createSchedule(sampleInput({ name: "plain" }), NOW);
    assert.equal(plain.maxRunMs, undefined);
    assert.equal(store.listSchedules().find((row) => row.id === capped.id)?.maxRunMs, 7_200_000);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createSchedule 只接受 60s..24h 的整数 maxRunMs", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    for (const maxRunMs of [0, -1, 1.5, 59_999, 86_400_001, Number.NaN]) {
      assert.throws(
        () => store.createSchedule(sampleInput({ maxRunMs }), NOW),
        (error: unknown) =>
          error instanceof ScheduleStoreError &&
          error.code === SCHEDULE_STORE_ERROR_CODES.invalid &&
          /maxRunMs/u.test(error.message),
        `maxRunMs=${String(maxRunMs)} 应被拒绝`,
      );
    }
    assert.equal(store.listSchedules().length, 0);
    assert.equal(
      store.createSchedule(sampleInput({ name: "min", maxRunMs: 60_000 }), NOW).maxRunMs,
      60_000,
    );
    assert.equal(
      store.createSchedule(sampleInput({ name: "max", maxRunMs: 86_400_000 }), NOW).maxRunMs,
      86_400_000,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读取持久化 schedule 时对越界、非整数和非数字 max_run_ms fail-closed", () => {
  for (const corruptValue of [59_999, 86_400_001, 60_000.5, "oops"] as const) {
    for (const reader of ["get", "list"] as const) {
      const dir = tempDir();
      try {
        const seed = new ScheduleStore(dir);
        const schedule = seed.createSchedule(sampleInput({ maxRunMs: 60_000 }), NOW);
        seed.close();

        const raw = new DatabaseSync(join(dir, "schedules.db"));
        raw
          .prepare("UPDATE schedules SET max_run_ms = ? WHERE id = ?")
          .run(corruptValue, schedule.id);
        raw.close();

        const store = new ScheduleStore(dir);
        assert.throws(
          () => (reader === "get" ? store.getSchedule(schedule.id) : store.listSchedules()),
          (error: unknown) =>
            error instanceof ScheduleStoreError &&
            error.code === SCHEDULE_STORE_ERROR_CODES.invalid &&
            /maxRunMs/u.test(error.message),
          `${reader} 应拒绝 max_run_ms=${String(corruptValue)}`,
        );
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("到期 schedule 的 max_run_ms 损坏时只暂停坏任务，健康任务仍可 claim", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const bad = store.createSchedule(sampleInput({ name: "bad", fireImmediately: true }), NOW);
    const healthy = store.createSchedule(
      sampleInput({ name: "healthy", fireImmediately: true }),
      NOW + 1,
    );
    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw.prepare("UPDATE schedules SET max_run_ms = ? WHERE id = ?").run("oops", bad.id);
    raw.close();

    const claims = store.claimDue({ workerId: "daemon", nowMs: NOW + 1, limit: 1 });
    assert.deepEqual(
      claims.map((claim) => claim.schedule.id),
      [healthy.id],
    );
    const check = new DatabaseSync(join(dir, "schedules.db"));
    const badRow = check
      .prepare("SELECT status, last_error FROM schedules WHERE id = ?")
      .get(bad.id) as { readonly status: string; readonly last_error: string };
    check.close();
    assert.equal(badRow.status, SCHEDULE_STATUSES.paused);
    assert.match(badRow.last_error, /maxRunMs/u);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 max_run_ms 的 pending manual 不回滚整个 claim 事务，健康任务不饥饿", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const bad = store.createSchedule(sampleInput({ name: "bad-pending" }), NOW);
    const pending = store.enqueueManualInvocation(bad.id, NOW);
    const healthy = store.createSchedule(
      sampleInput({ name: "healthy", fireImmediately: true }),
      NOW + 1,
    );
    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw.prepare("UPDATE schedules SET max_run_ms = ? WHERE id = ?").run(59_999, bad.id);
    raw.close();

    const claims = store.claimDue({ workerId: "daemon", nowMs: NOW + 1, limit: 2 });
    assert.deepEqual(
      claims.map((claim) => claim.schedule.id),
      [healthy.id],
    );
    assert.equal(store.getInvocation(pending.id)?.status, INVOCATION_STATUSES.pending);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 max_run_ms 的 retry 行被推迟，不阻塞健康 schedule claim", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBackoffMs: 1 });
    const bad = store.createSchedule(sampleInput({ name: "bad-retry" }), NOW);
    const queued = store.enqueueManualInvocation(bad.id, NOW);
    const first = store.claimPendingInvocation(queued.id, "daemon", NOW);
    assert.ok(first);
    store.failInvocation(queued.id, first.ownershipToken, "first failure", NOW);
    const healthy = store.createSchedule(
      sampleInput({ name: "healthy", fireImmediately: true }),
      NOW + 2,
    );
    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw.prepare("UPDATE schedules SET max_run_ms = ? WHERE id = ?").run("oops", bad.id);
    raw.close();

    const claims = store.claimDue({ workerId: "daemon", nowMs: NOW + 2, limit: 2 });
    assert.deepEqual(
      claims.map((claim) => claim.schedule.id),
      [healthy.id],
    );
    const deferred = store.getInvocation(queued.id);
    assert.equal(deferred?.status, INVOCATION_STATUSES.retry);
    assert.ok((deferred?.retryAtMs ?? 0) > NOW + 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 max_run_ms 的 dead-running 行保持 running 并续租，健康 schedule 仍可 claim", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    const bad = store.createSchedule(sampleInput({ name: "bad-running" }), NOW);
    const queued = store.enqueueManualInvocation(bad.id, NOW);
    const first = store.claimPendingInvocation(queued.id, "old-daemon", NOW);
    assert.ok(first);
    store.beginInvocation(queued.id, first.ownershipToken, NOW, {
      pid: 4242,
      startToken: "pst-v2:bad-running",
    });
    const healthy = store.createSchedule(
      sampleInput({ name: "healthy", fireImmediately: true }),
      NOW + 200_000,
    );
    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw.prepare("UPDATE schedules SET max_run_ms = ? WHERE id = ?").run("oops", bad.id);
    raw.close();

    const claims = store.claimDue({ workerId: "daemon", nowMs: NOW + 200_000, limit: 2 });
    assert.deepEqual(
      claims.map((claim) => claim.schedule.id),
      [healthy.id],
    );
    const deferred = store.getInvocation(queued.id);
    assert.equal(deferred?.status, INVOCATION_STATUSES.running);
    assert.ok((deferred?.leaseUntilMs ?? 0) > NOW + 200_000);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout late terminal CAS：finishedAt >= timedOutAt 时 scheduled 未耗尽预算把 completed 重分类为 retry", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3, retryBackoffMs: 10 });
    const schedule = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 1,
        threadId: "late-thread",
        outputExcerpt: "late-output",
      }),
      COMPLETE_INVOCATION_OUTCOMES.written,
    );

    assert.equal(typeof store.reclassifyTimedOutInvocation, "function");
    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: claim.invocation.id,
        expectedAttempt: 1,
        error: "max-run timeout",
        timedOutAtMs: NOW,
        nowMs: NOW + 2,
      }),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const reclassified = store.getInvocation(claim.invocation.id);
    assert.equal(reclassified?.status, INVOCATION_STATUSES.retry);
    assert.equal(reclassified?.finishedAtMs, undefined);
    assert.equal(reclassified?.threadId, undefined);
    assert.equal(reclassified?.outputExcerpt, undefined);
    assert.deepEqual(reclassified?.pendingActions, []);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    assert.equal(store.getSchedule(schedule.id)?.lastRunAtMs, NOW + 1);
    assert.equal(store.getSchedule(schedule.id)?.lastError, "max-run timeout");
    const retried = store.claimDue({ workerId: "daemon-2", nowMs: NOW + 12, limit: 1 })[0];
    assert.ok(retried);
    assert.equal(retried.invocation.id, claim.invocation.id);
    assert.equal(retried.invocation.attempt, 2);
    assert.equal(retried.invocation.threadId, undefined);
    assert.equal(retried.invocation.outputExcerpt, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout late terminal CAS：finishedAt < timedOutAt 时保留 completed", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const schedule = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 1,
        threadId: "on-time-thread",
        outputExcerpt: "on-time-output",
      }),
      COMPLETE_INVOCATION_OUTCOMES.written,
    );

    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: claim.invocation.id,
        expectedAttempt: 1,
        error: "max-run timeout",
        timedOutAtMs: NOW + 2,
        nowMs: NOW + 3,
      }),
      INVOCATION_FAILURE_OUTCOMES.lostClaim,
    );
    const completed = store.getInvocation(claim.invocation.id);
    assert.equal(completed?.status, INVOCATION_STATUSES.completed);
    assert.equal(completed?.finishedAtMs, NOW + 1);
    assert.equal(completed?.threadId, "on-time-thread");
    assert.equal(completed?.outputExcerpt, "on-time-output");
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    assert.equal(store.getSchedule(schedule.id)?.lastError, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout late terminal CAS：finishedAt === timedOutAt 时仍重分类", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 2, retryBackoffMs: 10 });
    const schedule = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 2,
      }),
      COMPLETE_INVOCATION_OUTCOMES.written,
    );

    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: claim.invocation.id,
        expectedAttempt: 1,
        error: "max-run timeout",
        timedOutAtMs: NOW + 2,
        nowMs: NOW + 3,
      }),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.retry);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout late terminal CAS：finishedAt 缺失时保守重分类", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 2, retryBackoffMs: 10 });
    const schedule = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 1,
      }),
      COMPLETE_INVOCATION_OUTCOMES.written,
    );
    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw.prepare("UPDATE invocations SET finished_at = NULL WHERE id = ?").run(claim.invocation.id);
    raw.close();

    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: claim.invocation.id,
        expectedAttempt: 1,
        error: "max-run timeout",
        timedOutAtMs: NOW + 2,
        nowMs: NOW + 3,
      }),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.retry);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout late terminal CAS：scheduled 预算耗尽时把 needs_confirmation 重分类为 failed 并 pause", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const schedule = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.needsConfirmation,
        pendingActions: ["agent.tool"],
        nowMs: NOW + 1,
        threadId: "late-confirmation-thread",
        outputExcerpt: "late-confirmation-output",
      }),
      COMPLETE_INVOCATION_OUTCOMES.written,
    );

    assert.equal(typeof store.reclassifyTimedOutInvocation, "function");
    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: claim.invocation.id,
        expectedAttempt: 1,
        error: "max-run timeout",
        timedOutAtMs: NOW,
        nowMs: NOW + 2,
      }),
      INVOCATION_FAILURE_OUTCOMES.terminalPaused,
    );
    const failed = store.getInvocation(claim.invocation.id);
    assert.equal(failed?.status, INVOCATION_STATUSES.failed);
    assert.equal(failed?.error, "max-run timeout");
    assert.equal(failed?.threadId, undefined);
    assert.equal(failed?.outputExcerpt, undefined);
    assert.deepEqual(failed?.pendingActions, []);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.paused);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout late terminal CAS：manual 按自身 maxAttempts 重试和终止，永不 pause schedule", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBackoffMs: 10 });
    const schedule = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(schedule.id, NOW, { maxAttempts: 2 });
    const first = store.claimPendingInvocation(queued.id, "inline", NOW);
    assert.ok(first);
    store.completeInvocation({
      id: queued.id,
      ownershipToken: first.ownershipToken,
      status: INVOCATION_STATUSES.completed,
      nowMs: NOW + 1,
    });

    assert.equal(typeof store.reclassifyTimedOutInvocation, "function");
    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: queued.id,
        expectedAttempt: 1,
        error: "attempt 1 timeout",
        timedOutAtMs: NOW,
        nowMs: NOW + 2,
      }),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const second = store.claimDue({ workerId: "daemon", nowMs: NOW + 12, limit: 1 })[0];
    assert.ok(second);
    assert.equal(second.invocation.attempt, 2);
    store.completeInvocation({
      id: queued.id,
      ownershipToken: second.ownershipToken,
      status: INVOCATION_STATUSES.needsConfirmation,
      pendingActions: ["agent.tool"],
      nowMs: NOW + 13,
    });
    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: queued.id,
        expectedAttempt: 2,
        error: "attempt 2 timeout",
        timedOutAtMs: NOW + 12,
        nowMs: NOW + 14,
      }),
      INVOCATION_FAILURE_OUTCOMES.terminal,
    );
    assert.equal(store.getInvocation(queued.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout late terminal CAS 拒绝错误 expectedAttempt，不改写已完成结果", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(schedule.id, NOW, { maxAttempts: 1 });
    const claim = store.claimPendingInvocation(queued.id, "inline", NOW);
    assert.ok(claim);
    store.completeInvocation({
      id: queued.id,
      ownershipToken: claim.ownershipToken,
      status: INVOCATION_STATUSES.completed,
      nowMs: NOW + 1,
    });

    assert.equal(typeof store.reclassifyTimedOutInvocation, "function");
    assert.equal(
      store.reclassifyTimedOutInvocation({
        id: queued.id,
        expectedAttempt: 2,
        error: "wrong attempt timeout",
        timedOutAtMs: NOW,
        nowMs: NOW + 2,
      }),
      INVOCATION_FAILURE_OUTCOMES.lostClaim,
    );
    assert.equal(store.getInvocation(queued.id)?.status, INVOCATION_STATUSES.completed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("打开 schema v4 数据库时补齐 schedules.max_run_ms 并升级到 v5", () => {
  const dir = tempDir();
  try {
    const legacy = new DatabaseSync(join(dir, "schedules.db"));
    legacy.exec(
      `CREATE TABLE schedules (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
         trigger_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
         authority_digest TEXT, next_run_at INTEGER, last_run_at INTEGER, last_error TEXT,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE invocations (
         id TEXT PRIMARY KEY,
         schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
         mode TEXT NOT NULL, status TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
         attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
         executor_pid INTEGER, executor_start_token TEXT, executor_probed_at INTEGER,
         claimed_by TEXT, ownership_token TEXT, lease_until INTEGER, retry_at INTEGER,
         thread_id TEXT, output_excerpt TEXT, error TEXT,
         pending_actions_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
         started_at INTEGER, finished_at INTEGER, tree_tracked_pgids TEXT,
         tree_unsettled INTEGER NOT NULL DEFAULT 0, tree_survivor_pids TEXT,
         UNIQUE (schedule_id, mode, scheduled_for));
       INSERT INTO schedules VALUES ('s1', 'n', 'p', '/w', '{"kind":"interval","everyMs":60000}',
         'active', NULL, 1, NULL, NULL, 1, 1);
       PRAGMA user_version = 4;`,
    );
    legacy.close();
    const store = new ScheduleStore(dir);
    assert.equal(store.getSchedule("s1")?.maxRunMs, undefined);
    store.close();
    const reopened = new DatabaseSync(join(dir, "schedules.db"));
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, 5);
    const columns = reopened.prepare("PRAGMA table_info(schedules)").all() as Array<{
      readonly name: string;
    }>;
    assert.ok(columns.some((column) => column.name === "max_run_ms"));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
