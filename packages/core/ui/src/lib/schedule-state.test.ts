import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScheduleStatusSummary } from "../types.ts";
import {
  SCHEDULE_ACTION_PATHS,
  SCHEDULE_ADD_EXAMPLE,
  SCHEDULE_KILL_CONFIRM,
  deriveScheduleWarnings,
  describeRunStatus,
  describeScheduleAction,
  describeScheduleActionResult,
  getInvocationCancelMode,
  isScheduleUnavailableError,
  type ScheduleAction,
} from "./schedule-state.ts";

function statusFixture(overrides: {
  installed?: boolean;
  running?: boolean;
  liveness?: string;
  active?: number;
  metadataStatus?: string;
  metadataPhase?: string;
  binary?: { status: string; reason?: string };
  installedDataDir?: string;
}): ScheduleStatusSummary {
  return {
    dataDir: "/tmp/sched",
    logPath: "/tmp/sched/scheduler.log",
    daemon: { liveness: overrides.liveness ?? "running" },
    service: {
      metadataStatus: overrides.metadataStatus ?? "valid",
      ...(overrides.metadataPhase !== undefined ? { metadataPhase: overrides.metadataPhase } : {}),
      installed: overrides.installed ?? true,
      running: overrides.running ?? true,
      ...(overrides.binary !== undefined ? { binary: overrides.binary } : {}),
      ...(overrides.installedDataDir !== undefined
        ? { installedDataDir: overrides.installedDataDir }
        : {}),
    },
    schedules: { total: 2, active: overrides.active ?? 2, paused: 0 },
  };
}

describe("schedule-state", () => {
  it("keeps one HTTP path per action", () => {
    const actions = Object.keys(SCHEDULE_ACTION_PATHS) as ScheduleAction[];
    assert.deepEqual(actions.sort(), [
      "cancel",
      "pause",
      "resume",
      "service-install",
      "service-restart",
      "service-uninstall",
    ]);
    const paths = Object.values(SCHEDULE_ACTION_PATHS);
    assert.equal(new Set(paths).size, paths.length);
    for (const path of paths) {
      assert.match(path, /^\/api\/schedule\//u);
    }
  });

  it("presents every action and requires confirmation only for uninstall", () => {
    for (const action of Object.keys(SCHEDULE_ACTION_PATHS) as ScheduleAction[]) {
      const presentation = describeScheduleAction(action);
      assert.ok(presentation.label.length > 0);
      assert.ok(presentation.progress.length > 0);
    }
    assert.ok(describeScheduleAction("service-uninstall").confirm);
    assert.equal(describeScheduleAction("pause").confirm, undefined);
    assert.match(SCHEDULE_KILL_CONFIRM, /进程树/u);
  });

  it("maps run statuses onto display tones with a neutral fallback", () => {
    assert.deepEqual(describeRunStatus("completed"), { label: "成功", tone: "ok" });
    assert.deepEqual(describeRunStatus("failed"), { label: "失败", tone: "error" });
    assert.deepEqual(describeRunStatus("running"), { label: "运行中", tone: "active" });
    assert.deepEqual(describeRunStatus("mystery"), { label: "mystery", tone: "neutral" });
  });

  it("offers plain cancel for queued runs and kill for running ones", () => {
    assert.equal(getInvocationCancelMode("pending"), "cancel");
    assert.equal(getInvocationCancelMode("claimed"), "cancel");
    assert.equal(getInvocationCancelMode("retry"), "cancel");
    assert.equal(getInvocationCancelMode("running"), "kill");
    assert.equal(getInvocationCancelMode("completed"), undefined);
    assert.equal(getInvocationCancelMode("failed"), undefined);
  });

  it("derives warnings for the states users must act on", () => {
    assert.deepEqual(deriveScheduleWarnings(statusFixture({})), []);

    const notInstalled = deriveScheduleWarnings(
      statusFixture({ installed: false, running: false, liveness: "stopped", active: 1 }),
    );
    assert.equal(notInstalled.length, 1);
    assert.match(notInstalled[0] ?? "", /不会自动运行/u);

    assert.deepEqual(
      deriveScheduleWarnings(
        statusFixture({ installed: false, running: false, liveness: "stopped", active: 0 }),
      ),
      [],
    );

    const outdated = deriveScheduleWarnings(
      statusFixture({ binary: { status: "outdated", reason: "roll 版本已更新" } }),
    );
    assert.equal(outdated.length, 1);
    assert.match(outdated[0] ?? "", /过期（roll 版本已更新）/u);

    const stoppedDaemon = deriveScheduleWarnings(statusFixture({ liveness: "stopped" }));
    assert.equal(stoppedDaemon.length, 1);
    assert.match(stoppedDaemon[0] ?? "", /daemon 未运行/u);

    const installing = deriveScheduleWarnings(statusFixture({ metadataPhase: "installing" }));
    assert.ok(installing.some((w) => w.includes("未完成")));

    const invalid = deriveScheduleWarnings(statusFixture({ metadataStatus: "invalid" }));
    assert.ok(invalid.some((w) => w.includes("fail-closed")));
  });

  it("warns loudly when the installed service pins a different data-dir", () => {
    const forked = deriveScheduleWarnings(statusFixture({ installedDataDir: "/tmp/old-sched" }));
    assert.equal(forked.length, 1);
    assert.match(forked[0] ?? "", /\/tmp\/old-sched/u);
    assert.match(forked[0] ?? "", /\/tmp\/sched/u);
    assert.match(forked[0] ?? "", /仍会被执行|仍会执行/u);
    assert.match(forked[0] ?? "", /不在下方显示/u);

    assert.deepEqual(deriveScheduleWarnings(statusFixture({ installedDataDir: "/tmp/sched" })), []);
  });

  it("keeps CLI-visible warnings from action results instead of a blanket success", () => {
    assert.deepEqual(describeScheduleActionResult("pause", { ok: true }), {
      tone: "success",
      message: "暂停已完成。",
    });
    const unverified = describeScheduleActionResult("cancel", {
      ok: true,
      killed: true,
      unverifiedDescendants: true,
    });
    assert.equal(unverified.tone, "warning");
    assert.match(unverified.message, /后代进程/u);
    assert.match(unverified.message, /手动检查/u);
    const reauthorized = describeScheduleActionResult("resume", {
      ok: true,
      authorityChanged: true,
    });
    assert.equal(reauthorized.tone, "success");
    assert.match(reauthorized.message, /重新授权/u);
    assert.deepEqual(describeScheduleActionResult("service-install", undefined), {
      tone: "success",
      message: "安装服务已完成。",
    });
  });

  it("shows a runnable schedule add example (prompt is positional, no --prompt flag)", () => {
    assert.match(SCHEDULE_ADD_EXAMPLE, /^roll schedule add "/u);
    assert.match(SCHEDULE_ADD_EXAMPLE, /--name/u);
    assert.match(SCHEDULE_ADD_EXAMPLE, /--every/u);
    assert.doesNotMatch(SCHEDULE_ADD_EXAMPLE, /--prompt/u);
  });

  it("recognizes the schedule_unavailable API error", () => {
    assert.equal(isScheduleUnavailableError({ status: 404, code: "schedule_unavailable" }), true);
    assert.equal(isScheduleUnavailableError({ status: 404, code: "not_found" }), false);
    assert.equal(isScheduleUnavailableError({ status: 500, code: "schedule_unavailable" }), false);
    assert.equal(isScheduleUnavailableError(new Error("x")), false);
  });
});
