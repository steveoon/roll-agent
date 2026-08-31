import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readScheduleLedger } from "@roll-agent/runtime";
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
