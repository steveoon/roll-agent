import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "@roll-agent/runtime";
import { scheduleHostContextSchema } from "@roll-agent/runtime/host-contracts";
import { createScheduleToolBinding } from "./schedule-tool-binding.ts";
import { encodeScheduleHostContext, loadScheduleConfig } from "./config-context.ts";

test("bound schedule tools use selected source for ledger, approval, reopen and extension", async () => {
  const root = mkdtempSync(join(tmpdir(), "roll-bound-schedule-"));
  const source = join(root, "source");
  const task = join(root, "task");
  mkdirSync(source);
  mkdirSync(task);
  const configPath = join(source, "roll.config.yaml");
  const ledger = join(source, "ledger");
  const yaml = (model: string) =>
    `scheduler:\n  data-dir: ./ledger\nllm:\n  default-model: ${model}\n  providers:\n    qwen:\n      api-key: token-never-persist-fixture-secret\n`;
  writeFileSync(configPath, yaml("selected"));
  writeFileSync(join(task, "roll.config.yaml"), "scheduler:\n  data-dir: ./wrong-ledger\n");
  const context = { version: 1 as const, configPath, configWorkspace: source };
  const options = {
    configContext: context,
    serviceStatePath: join(root, "service.json"),
    secretsPath: join(root, "secrets.env"),
  };
  try {
    const binding = createScheduleToolBinding(options);
    const captured = binding.captureCreate(
      { name: "bound", prompt: "fixture", every: "1h", rounds: 2 },
      task,
    );
    assert.ok(captured.ok);
    assert.equal(captured.dataDir, ledger);
    writeFileSync(configPath, yaml("changed-during-approval"));
    const rejected = await binding.create(captured);
    assert.ok(!rejected.ok);
    assert.equal(rejected.code, "admission_stale");
    const fresh = binding.captureCreate(
      { name: "bound", prompt: "fixture", every: "1h", rounds: 2 },
      task,
    );
    assert.ok(fresh.ok);
    const made = await binding.create(fresh);
    assert.ok(made.ok);
    assert.equal("hostContext" in made.schedule, false);
    const store = new ScheduleStore(ledger);
    const schedule = store.getSchedule(made.schedule.id);
    assert.ok(schedule);
    for (let round = 1; round <= 2; round++) {
      const nowMs = Date.now() + round * 3_600_000 + 100;
      const claim = store.claimDue({ workerId: "fixture", nowMs, limit: 1 })[0];
      assert.ok(claim);
      assert.equal(
        store.completeInvocation({
          id: claim.invocation.id,
          ownershipToken: claim.ownershipToken,
          status: "completed",
          nowMs: nowMs + 1,
        }),
        "written",
      );
    }
    store.close();
    assert.equal(schedule.hostContext, encodeScheduleHostContext(context));
    assert.deepEqual(JSON.parse(schedule.hostContext), context);
    assert.equal(
      readFileSync(join(ledger, "schedules.db")).includes(
        Buffer.from("token-never-persist-fixture-secret"),
      ),
      false,
    );
    assert.equal(loadScheduleConfig(schedule).config.llm.defaultModel, "changed-during-approval");
    const otherConfig = join(source, "other.yaml");
    writeFileSync(
      otherConfig,
      "scheduler:\n  data-dir: ./ledger\nruntime:\n  approval:\n    default: deny\n",
    );
    const restarted = createScheduleToolBinding({
      ...options,
      configContext: { ...context, configPath: otherConfig },
    });
    const listed = await restarted.list({}, task);
    assert.ok(listed.ok);
    assert.equal(listed.total, 1);
    assert.ok(restarted.captureExtend && restarted.extend);
    const extend = restarted.captureExtend(
      { scheduleId: schedule.id, rounds: 1, expectedMaxRounds: 2, requestId: "extend-bound" },
      task,
    );
    assert.ok(extend.ok);
    writeFileSync(configPath, yaml("changed-during-extension"));
    const staleExtension = await restarted.extend(extend);
    assert.ok(!staleExtension.ok);
    assert.equal(staleExtension.code, "admission_stale");
    const refreshedExtension = restarted.captureExtend(
      { scheduleId: schedule.id, rounds: 1, expectedMaxRounds: 2, requestId: "extend-bound" },
      task,
    );
    assert.ok(refreshedExtension.ok);
    const extended = await restarted.extend(refreshedExtension);
    assert.ok(extended.ok, JSON.stringify(extended));
    assert.equal(extended.schedule.rounds.max, 3);
    unlinkSync(configPath);
    assert.throws(() => loadScheduleConfig(schedule), /not found/);
    assert.throws(
      () =>
        loadScheduleConfig({ cwd: task, hostContext: scheduleHostContextSchema.parse("{broken") }),
      /refusing cwd fallback/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
