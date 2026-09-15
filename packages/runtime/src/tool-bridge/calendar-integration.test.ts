import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSchema, type ToolExecutionOptions } from "ai";
import { createScheduleToolBinding } from "@roll-agent/core/scheduler-host/schedule-tool-binding";
import { ScheduleStore, readScheduleLedger } from "../scheduler/schedule-store.ts";
import { buildScheduleToolset, SCHEDULE_CREATE_TOOL_ID } from "./schedule-tool.ts";
import { ToolRegistry } from "./naming.ts";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const START = NOW + 86_400_000;
for (const timing of [
  { every: "30m", startAt: "2026-09-16T08:00:00+08:00" },
  { calendar: { frequency: "daily", time: "08:00", timeZone: "Asia/Shanghai" } },
  { calendar: { frequency: "weekly", time: "08:00", timeZone: "Asia/Shanghai", weekdays: [3] } },
]) {
  test(`real tool + binding + SQLite claim: ${JSON.stringify(timing)}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const root = mkdtempSync(join(tmpdir(), "roll-calendar-tool-"));
    const dataDir = join(root, "ledger");
    writeFileSync(
      join(root, "roll.config.yaml"),
      JSON.stringify({ scheduler: { "data-dir": dataDir } }),
    );
    try {
      const confirmations: Record<string, unknown>[] = [];
      const port = createScheduleToolBinding({
        serviceStatePath: join(root, "service.json"),
        secretsPath: join(root, "secrets.env"),
      });
      const tools = buildScheduleToolset({ port, sessionCwd: root }, new ToolRegistry(), {
        policy: { check: () => ({ action: "confirm" }) },
        requestApproval: async (request) => {
          confirmations.push(request.input);
          return { approved: true };
        },
      });
      const tool = tools.createTools[SCHEDULE_CREATE_TOOL_ID];
      assert.ok(tool?.execute);
      const schema = await asSchema(tool.inputSchema).jsonSchema;
      assert.match(JSON.stringify(schema), /"calendar"/u);
      assert.doesNotMatch(JSON.stringify(schema), /"default":"Asia/u);
      const result = await tool.execute(
        { name: "未读巡检", prompt: "检查未读消息", rounds: 20, ...timing },
        {
          toolCallId: "calendar-1",
          messages: [],
          context: undefined,
        } satisfies ToolExecutionOptions<unknown>,
      );
      assert.ok(typeof result === "object" && result !== null && "isError" in result);
      assert.equal(result.isError, false);
      assert.equal(confirmations.length, 1);
      assert.equal(confirmations[0]?.firstRunAtIso, new Date(START).toISOString());
      assert.match(String(confirmations[0]?.rounds), /20/u);
      const saved = readScheduleLedger(dataDir).schedules[0];
      assert.ok(saved);
      assert.equal(saved.nextRunAtMs, START);
      const store = new ScheduleStore(dataDir);
      try {
        assert.deepEqual(store.claimDue({ workerId: "early", nowMs: START - 1, limit: 1 }), []);
        assert.equal(store.claimDue({ workerId: "due", nowMs: START, limit: 1 }).length, 1);
        assert.equal(store.getSchedule(saved.id)?.roundsStarted, 1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
