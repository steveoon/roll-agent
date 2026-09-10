import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ScheduleStore, type ClaimedInvocation } from "@roll-agent/runtime";
import { createBundledRollInvocation } from "../companion-host/invocation.ts";
import { SchedulerDaemon } from "./daemon.ts";
import { probeExecutorLiveness } from "./executor-liveness.ts";
import { createInvocationSpawner, type SpawnedInvocation } from "./spawn-invocation.ts";

test(
  "finite rounds retry across a daemon restart, stop, and run again only after explicit extension",
  { timeout: 30_000 },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-finite-daemon-"));
    const logPath = join(dataDir, "exec.log");
    let nowMs = Date.parse("2026-09-10T01:00:00Z");
    let store = new ScheduleStore(dataDir, { executorLiveness: probeExecutorLiveness });
    const claims: ClaimedInvocation[] = [];
    const children: SpawnedInvocation[] = [];
    const pending = new Set<SpawnedInvocation>();
    const logger = { info: () => undefined, error: () => undefined };
    const createDaemon = (workerId: string) =>
      new SchedulerDaemon({
        store,
        workerId,
        maxConcurrentRuns: 1,
        now: () => nowMs,
        logger,
        spawnInvocation: (claim) => {
          claims.push(claim);
          const spawn = createInvocationSpawner({
            dataDir,
            logPath,
            invocation: createBundledRollInvocation({
              command: process.execPath,
              cliEntrypoint: join(import.meta.dirname, "schedule-rounds-executor.e2e-harness.ts"),
              execArgv: ["--experimental-strip-types", "--experimental-sqlite"],
            }),
            env: {
              ...process.env,
              ROLL_FINITE_TEST_NOW: String(nowMs),
              ROLL_FINITE_TEST_ROUNDS: String(claim.schedule.maxRounds),
            },
          });
          const child = spawn(claim);
          children.push(child);
          pending.add(child);
          child.exited.finally(() => pending.delete(child));
          return child;
        },
      });
    try {
      const schedule = store.createSchedule(
        {
          name: "隔离巡检",
          prompt: "检查未读消息",
          cwd: dataDir,
          trigger: { kind: "interval", everyMs: 1_800_000 },
          fireImmediately: true,
          maxRounds: 1,
        },
        nowMs,
      );
      const firstDaemon = createDaemon("before-restart");
      assert.equal(firstDaemon.tick(), 1);
      assert.equal(await children[0]?.exited, 1, readFileSync(logPath, "utf8"));
      await setImmediate();
      assert.equal(firstDaemon.runningCount, 0);
      const retry = store.listInvocations(schedule.id)[0];
      assert.ok(retry, readFileSync(logPath, "utf8"));
      assert.equal(retry.status, "retry", readFileSync(logPath, "utf8"));
      assert.equal(retry.error, "isolated first-attempt failure", readFileSync(logPath, "utf8"));
      assert.ok(retry.executor, "executeInvocation persisted the child OS identity");
      assert.equal(probeExecutorLiveness(retry.executor), "dead");
      assert.equal(store.getSchedule(schedule.id)?.roundsStarted, 1);
      assert.equal(store.getSchedule(schedule.id)?.nextRunAtMs, undefined);
      assert.equal(store.getSchedule(schedule.id)?.status, "active");
      assert.equal(
        firstDaemon.tick(),
        0,
        "retry backoff must still apply after the quota is exhausted",
      );
      assert.ok(retry.retryAtMs);
      store.close();
      store = new ScheduleStore(dataDir, { executorLiveness: probeExecutorLiveness });
      nowMs = retry.retryAtMs;
      const secondDaemon = createDaemon("after-restart");
      assert.equal(secondDaemon.tick(), 1);
      assert.equal(await children[1]?.exited, 0, readFileSync(logPath, "utf8"));
      await setImmediate();
      assert.equal(secondDaemon.runningCount, 0);
      assert.equal(claims[1]?.invocation.id, retry.id);
      assert.equal(claims[1]?.invocation.attempt, 2);
      const final = store.getSchedule(schedule.id);
      assert.equal(final?.status, "completed");
      assert.equal(final.roundsStarted, 1);
      assert.equal(final.nextRunAtMs, undefined);
      assert.equal(store.getInvocation(retry.id)?.threadId, "isolated-final-thread");
      assert.equal(store.getInvocation(retry.id)?.outputExcerpt, "no unread messages");
      nowMs += 7 * 24 * 60 * 60_000;
      assert.equal(secondDaemon.tick(), 0);
      assert.equal(secondDaemon.tick(), 0);
      assert.equal(
        children.length,
        2,
        "only the original attempt and its retry may start executors",
      );
      assert.equal(store.listInvocations(schedule.id).length, 1);
      const extended = store.extendSchedule(
        {
          scheduleId: schedule.id,
          additionalRounds: 1,
          expectedMaxRounds: 1,
          requestId: "subprocess-extension",
          authorityDigest: "fixture-reauthorized",
        },
        nowMs,
      );
      assert.equal(extended.schedule.id, schedule.id);
      assert.equal(extended.schedule.maxRounds, 2);
      assert.equal(extended.schedule.roundsStarted, 1);
      assert.equal(secondDaemon.tick(), 0, "extension must wait for the next interval");
      assert.equal(extended.schedule.nextRunAtMs, nowMs + 1_800_000);
      nowMs += 1_800_000;
      assert.equal(secondDaemon.tick(), 1);
      assert.equal(await children[2]?.exited, 1, readFileSync(logPath, "utf8"));
      await setImmediate();
      const lastRetry = store.listInvocations(schedule.id)[0];
      assert.ok(lastRetry?.retryAtMs);
      assert.notEqual(lastRetry.id, retry.id);
      assert.equal(store.getSchedule(schedule.id)?.roundsStarted, 2);
      assert.equal(store.getSchedule(schedule.id)?.nextRunAtMs, undefined);
      nowMs = lastRetry.retryAtMs;
      assert.equal(secondDaemon.tick(), 1);
      assert.equal(await children[3]?.exited, 0, readFileSync(logPath, "utf8"));
      await setImmediate();
      assert.equal(store.getSchedule(schedule.id)?.status, "completed");
      assert.equal(store.getSchedule(schedule.id)?.roundsStarted, 2);
      assert.equal(store.listInvocations(schedule.id).length, 2);
      nowMs += 7 * 24 * 60 * 60_000;
      assert.equal(secondDaemon.tick(), 0);
      assert.equal(children.length, 4);
    } finally {
      for (const child of pending) child.kill("SIGKILL");
      await Promise.allSettled([...pending].map((child) => child.exited));
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
