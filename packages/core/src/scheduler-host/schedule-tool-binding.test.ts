import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readScheduleLedger, ScheduleStore } from "@roll-agent/runtime";
import { DatabaseSync } from "./database-fixture.test.ts";
import { createDaemonRecord, writeDaemonRecord } from "./daemon-record.ts";
import {
  SCHEDULE_TOOL_ERROR_CODES,
  createScheduleToolBinding,
  type ScheduleCreateAdmission,
} from "./schedule-tool-binding.ts";

interface Workspace {
  readonly cwd: string;
  readonly dataDir: string;
  readonly serviceStatePath: string;
  close(): void;
}

function createWorkspace(): Workspace {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-binding-"));
  const dataDir = join(root, "sched-data");
  writeFileSync(
    join(root, "roll.config.yaml"),
    `scheduler:\n  data-dir: ${dataDir}\n  max-schedules: 3\n`,
  );
  return {
    cwd: root,
    dataDir,
    serviceStatePath: join(root, "scheduler-service.json"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function requireAdmission(value: unknown): ScheduleCreateAdmission {
  assert.ok(typeof value === "object" && value !== null && (value as { ok: boolean }).ok === true);
  return value as ScheduleCreateAdmission;
}

test("live legacy daemon refuses creation before migration, and readiness reports restart required", async () => {
  const ws = createWorkspace();
  try {
    const store = new ScheduleStore(ws.dataDir);
    store.close();
    const dbPath = join(ws.dataDir, "schedules.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version=8");
    raw.close();
    const before = readFileSync(dbPath);
    writeDaemonRecord(join(ws.dataDir, "daemon.json"), createDaemonRecord("legacy"));
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const result = binding.captureCreate(
      { name: "calendar", prompt: "noop", calendar: { frequency: "daily", time: "08:00" } },
      ws.cwd,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /重启/u);
    const list = await binding.list({}, ws.cwd);
    assert.ok(list.ok);
    assert.equal(list.readiness.automaticRunsReady, false);
    assert.ok(
      list.readiness.warnings.some((warning) => warning.code === "daemon-version-mismatch"),
    );
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    ws.close();
  }
});

test("calendar binding captures host zone and preserves a future start through approval and duplicate creation", async (t) => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const admission = requireAdmission(
      binding.captureCreate(
        {
          name: "calendar",
          prompt: "检查未读",
          every: "30m",
          rounds: 20,
          startAt: "2026-09-16T08:00:00+08:00",
        },
        ws.cwd,
      ),
    );
    assert.equal(admission.firstRunAt, "2026-09-16T00:00:00.000Z");
    t.mock.timers.setTime(now + 60_000);
    const result = await binding.create(admission);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.schedule.nextRunAt, admission.firstRunAt);
    assert.deepEqual(result.schedule.trigger.spec, admission.trigger);
    assert.equal(result.schedule.rounds.max, 20);
    const replay = await binding.create(admission);
    assert.ok(replay.ok);
    assert.equal(replay.created, false);
    assert.equal(replay.schedule.id, result.schedule.id);
    const daily = requireAdmission(
      binding.captureCreate(
        { name: "daily", prompt: "检查", calendar: { frequency: "daily", time: "08:00" } },
        ws.cwd,
      ),
    );
    assert.equal(daily.trigger.kind, "calendar");
    if (daily.trigger.kind === "calendar") {
      assert.equal(
        daily.trigger.calendar.timeZone,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    }
  } finally {
    ws.close();
  }
});

test("calendar binding rejects expired approvals and conflicting recurrence before creating a ledger", async (t) => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    assert.equal(
      binding.captureCreate(
        {
          name: "bad",
          prompt: "bad",
          every: "30m",
          calendar: { frequency: "daily", time: "08:00" },
        },
        ws.cwd,
      ).ok,
      false,
    );
    for (const timing of [
      { every: "30m", startAt: "2026-09-16T08:00:00+08:00" },
      { calendar: { frequency: "daily" as const, time: "08:00", timeZone: "Asia/Shanghai" } },
    ]) {
      t.mock.timers.setTime(now);
      const admission = requireAdmission(
        binding.captureCreate({ name: "late", prompt: "late", ...timing }, ws.cwd),
      );
      t.mock.timers.setTime(Date.parse(admission.firstRunAt) + 1);
      const result = await binding.create(admission);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "admission_stale");
      assert.equal(readScheduleLedger(ws.dataDir).status, "empty");
    }
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding captureCreate 产出 canonical admission 与 readiness", () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const admission = requireAdmission(
      binding.captureCreate(
        { name: "未读巡检", prompt: "检查未读消息并汇总", every: "30m" },
        ws.cwd,
      ),
    );
    assert.equal(admission.cwd, ws.cwd);
    assert.equal(admission.everyMs, 1_800_000);
    assert.equal(admission.everyDisplay, "每 30 分钟");
    assert.equal(admission.maxRunMs, undefined);
    assert.equal(admission.maxRunDisplay, "1 小时");
    assert.equal(admission.dataDir, ws.dataDir);
    assert.match(admission.authorityDigest, /^v1:[0-9a-f]{64}$/u);
    assert.equal(admission.readiness.serviceInstalled, false);
    assert.equal(admission.readiness.automaticRunsReady, false);
    assert.equal(admission.readiness.warnings[0]?.code, "service-not-installed");
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding captureCreate 透传 trigger/cwd 错误", () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const badEvery = binding.captureCreate({ name: "x", prompt: "y", every: "五分钟" }, ws.cwd);
    assert.ok(badEvery.ok === false);
    assert.equal(badEvery.code, "schedule_trigger_invalid");

    const badCwd = binding.captureCreate(
      { name: "x", prompt: "y", every: "30m", cwd: "./missing-dir" },
      ws.cwd,
    );
    assert.ok(badCwd.ok === false);
    assert.equal(badCwd.code, SCHEDULE_TOOL_ERROR_CODES.invalidInput);
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding create 落账本、重复创建返回 created:false", async () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const admission = requireAdmission(
      binding.captureCreate(
        { name: "未读巡检", prompt: "检查未读消息并汇总", every: "30m", maxRun: "2h" },
        ws.cwd,
      ),
    );
    const outcome = await binding.create(admission);
    assert.ok(outcome.ok === true);
    assert.equal(outcome.created, true);
    assert.equal(outcome.schedule.maxRun.explicit, true);
    assert.equal(outcome.schedule.maxRun.effectiveMs, 7_200_000);

    const ledger = readScheduleLedger(ws.dataDir);
    assert.equal(ledger.status, "ok");
    assert.equal(ledger.schedules.length, 1);
    assert.equal(ledger.schedules[0]?.authorityDigest, admission.authorityDigest);

    const replay = await binding.create(admission);
    assert.ok(replay.ok === true);
    assert.equal(replay.created, false);
    assert.equal(replay.schedule.id, outcome.schedule.id);
    assert.equal(readScheduleLedger(ws.dataDir).schedules.length, 1);
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding create 在权限边界漂移时 fail-closed", async () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const admission = requireAdmission(
      binding.captureCreate({ name: "巡检", prompt: "检查", every: "30m" }, ws.cwd),
    );
    const stale = await binding.create({
      ...admission,
      authorityDigest: "v1:0000000000000000000000000000000000000000000000000000000000000000",
    });
    assert.ok(stale.ok === false);
    assert.equal(stale.code, SCHEDULE_TOOL_ERROR_CODES.admissionStale);
    assert.equal(readScheduleLedger(ws.dataDir).schedules.length, 0);
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding list 分页、过滤并截断 prompt", async () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const longPrompt = `检查${"很长".repeat(150)}`;
    for (const [name, prompt] of [
      ["任务一", longPrompt],
      ["任务二", "短任务"],
      ["任务三", "另一个"],
    ] as const) {
      const admission = requireAdmission(
        binding.captureCreate({ name, prompt, every: "30m" }, ws.cwd),
      );
      const outcome = await binding.create(admission);
      assert.ok(outcome.ok === true);
    }
    const all = await binding.list({}, ws.cwd);
    assert.ok(all.ok === true);
    assert.equal(all.total, 3);
    assert.equal(all.hasMore, false);
    assert.ok(all.schedules[0]?.promptExcerpt.endsWith("…"));
    assert.ok(all.schedules[0]!.promptExcerpt.length <= 201);

    const paged = await binding.list({ offset: 1, limit: 1 }, ws.cwd);
    assert.ok(paged.ok === true);
    assert.equal(paged.schedules.length, 1);
    assert.equal(paged.schedules[0]?.name, "任务二");
    assert.equal(paged.hasMore, true);

    const none = await binding.list({ status: "paused" }, ws.cwd);
    assert.ok(none.ok === true);
    assert.equal(none.total, 0);
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding 显式跨 cwd：账本随会话、authority 随任务目录", async () => {
  const ws = createWorkspace();
  try {
    const projectB = join(ws.cwd, "project-b");
    const dataDirB = join(projectB, "sched-data-b");
    mkdirSync(projectB, { recursive: true });
    writeFileSync(
      join(projectB, "roll.config.yaml"),
      `scheduler:\n  data-dir: ${dataDirB}\nruntime:\n  approval:\n    default: auto\n`,
    );
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const sessionAdmission = requireAdmission(
      binding.captureCreate({ name: "会话内", prompt: "本地任务", every: "30m" }, ws.cwd),
    );
    const crossAdmission = requireAdmission(
      binding.captureCreate(
        { name: "跨目录", prompt: "在 B 项目执行", every: "30m", cwd: "project-b" },
        ws.cwd,
      ),
    );
    assert.equal(crossAdmission.cwd, projectB);
    assert.equal(crossAdmission.sessionCwd, ws.cwd);
    assert.equal(crossAdmission.dataDir, ws.dataDir);
    assert.notEqual(crossAdmission.authorityDigest, sessionAdmission.authorityDigest);

    const outcome = await binding.create(crossAdmission);
    assert.ok(outcome.ok === true);
    assert.equal(readScheduleLedger(ws.dataDir).schedules.length, 1);
    assert.equal(readScheduleLedger(dataDirB).status, "empty");

    const listed = await binding.list({}, ws.cwd);
    assert.ok(listed.ok === true);
    assert.equal(listed.total, 1);
    assert.equal(listed.schedules[0]?.cwd, projectB);
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding 幂等命中且权限漂移时重新授权并透传标记", async () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const first = requireAdmission(
      binding.captureCreate({ name: "巡检", prompt: "检查", every: "30m" }, ws.cwd),
    );
    const created = await binding.create(first);
    assert.ok(created.ok === true && created.created === true);

    writeFileSync(
      join(ws.cwd, "roll.config.yaml"),
      `scheduler:\n  data-dir: ${ws.dataDir}\n  max-schedules: 3\nruntime:\n  approval:\n    default: auto\n`,
    );
    const second = requireAdmission(
      binding.captureCreate({ name: "巡检", prompt: "检查", every: "30m" }, ws.cwd),
    );
    assert.notEqual(second.authorityDigest, first.authorityDigest);
    const replay = await binding.create(second);
    assert.ok(replay.ok === true);
    assert.equal(replay.created, false);
    assert.equal(replay.reauthorized, true);
    assert.equal(
      readScheduleLedger(ws.dataDir).schedules[0]?.authorityDigest,
      second.authorityDigest,
    );
  } finally {
    ws.close();
  }
});

test("schedule-tool-binding readiness 报告调度服务环境下无法解析的占位符", () => {
  const ws = createWorkspace();
  try {
    writeFileSync(
      join(ws.cwd, "roll.config.yaml"),
      [
        "scheduler:",
        `  data-dir: ${ws.dataDir}`,
        "llm:",
        "  providers:",
        "    qwen:",
        `      api-key: \${BINDING_PROBE_KEY}`,
        "",
      ].join("\n"),
    );
    const secretsPath = join(ws.cwd, "secrets.env");
    const binding = createScheduleToolBinding({
      serviceStatePath: ws.serviceStatePath,
      secretsPath,
    });
    const admission = requireAdmission(
      binding.captureCreate({ name: "巡检", prompt: "检查未读", every: "30m" }, ws.cwd),
    );
    const warning = admission.readiness.warnings.find(
      (item) => item.code === "unresolved-placeholders",
    );
    assert.ok(warning !== undefined);
    assert.match(warning.message, /BINDING_PROBE_KEY/);
    assert.match(warning.message, /secrets\.env/);

    writeFileSync(secretsPath, "BINDING_PROBE_KEY=resolved\n");
    const resolved = requireAdmission(
      binding.captureCreate({ name: "巡检", prompt: "检查未读", every: "30m" }, ws.cwd),
    );
    assert.equal(
      resolved.readiness.warnings.some((item) => item.code === "unresolved-placeholders"),
      false,
    );
  } finally {
    ws.close();
  }
});

test("finite rounds flow through admission, ledger, idempotent create and read-only list", async () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    const request = { name: "巡检", prompt: "检查未读消息并回复", every: "30m", rounds: 20 };
    const admission = requireAdmission(binding.captureCreate(request, ws.cwd));
    assert.equal(admission.maxRounds, 20);
    const created = await binding.create(admission);
    assert.ok(created.ok);
    assert.deepEqual(created.schedule.rounds, { max: 20, started: 0 });
    assert.equal(created.schedule.roundsDisplay, "已触发 0/20 轮");
    const replay = await binding.create(admission);
    assert.ok(replay.ok);
    assert.equal(replay.created, false);
    assert.equal(replay.schedule.id, created.schedule.id);
    const unlimited = await binding.create(
      requireAdmission(
        binding.captureCreate(
          {
            name: request.name,
            prompt: request.prompt,
            every: request.every,
          },
          ws.cwd,
        ),
      ),
    );
    assert.ok(unlimited.ok);
    assert.equal(unlimited.created, true);
    assert.notEqual(unlimited.schedule.id, created.schedule.id);
    const list = await binding.list({}, ws.cwd);
    assert.ok(list.ok);
    assert.deepEqual(list.schedules.find((item) => item.id === created.schedule.id)?.rounds, {
      max: 20,
      started: 0,
    });
    const stored = readScheduleLedger(ws.dataDir).schedules.find(
      (item) => item.id === created.schedule.id,
    );
    assert.equal(stored?.maxRounds, 20);
    assert.equal(stored.roundsStarted, 0);
  } finally {
    ws.close();
  }
});

test("capture rejects invalid rounds even for direct binding callers", () => {
  const ws = createWorkspace();
  try {
    const binding = createScheduleToolBinding({ serviceStatePath: ws.serviceStatePath });
    for (const rounds of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const result = binding.captureCreate(
        { name: "巡检", prompt: "检查", every: "30m", rounds },
        ws.cwd,
      );
      assert.equal(result.ok, false, String(rounds));
    }
    assert.equal(readScheduleLedger(ws.dataDir).schedules.length, 0);
  } finally {
    ws.close();
  }
});
