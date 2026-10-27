import assert from "node:assert/strict";
import test from "node:test";
import { asSchema } from "ai";
import { buildScheduleToolset, SCHEDULE_CREATE_TOOL_ID } from "./schedule-tool.ts";
import { ToolRegistry } from "./naming.ts";
import { scheduleCreateInputSchema, toScheduleCreateRequest } from "./schedule-create-input.ts";

const defaults = {
  name: "probe",
  prompt: "noop",
  startAt: null,
  cwd: null,
  rounds: null,
  maxRun: null,
};

function modelTool() {
  const tools = buildScheduleToolset(
    {
      sessionCwd: process.cwd(),
      port: {
        captureCreate: () => {
          throw new Error("must not call admission");
        },
        create: () => {
          throw new Error("must not create a task");
        },
        list: () => {
          throw new Error("must not read a ledger");
        },
      },
    },
    new ToolRegistry(),
    { requestApproval: async () => ({ approved: false }) },
  );
  const tool = tools.createTools[SCHEDULE_CREATE_TOOL_ID];
  assert.ok(tool);
  return tool;
}

test("original screenshot counterexample is rejected by the model tool schema, not only Runtime", async () => {
  const schema = asSchema(modelTool().inputSchema);
  assert.ok(schema.validate);
  const result = await schema.validate({
    name: "飞书测试",
    prompt: "仅测试参数，不执行业务",
    every: "1d",
    calendar: { frequency: "daily", time: "14:20", timeZone: "Asia/Singapore" },
    startAt: "2026-09-15T14:20",
    rounds: 2,
  });
  assert.equal(result.success, false);
});

test("schedule creation explicitly opts into provider strict mode", () => {
  assert.equal(modelTool().strict, true);
});

test("model schema projection preserves schedule input transformations", async () => {
  const schema = asSchema(modelTool().inputSchema);
  const wire = await schema.jsonSchema;
  assert.doesNotMatch(JSON.stringify(wire), /"oneOf":/u);
  assert.match(JSON.stringify(wire), /"anyOf":/u);
  assert.ok(schema.validate);
  const input = {
    ...defaults,
    name: "  probe  ",
    recurrence: {
      kind: "weekly",
      time: "08:00",
      weekdays: [5, 1, 1],
      timeZone: "Asia/Shanghai",
    },
  };
  const result = await schema.validate(input);
  assert.ok(result.success);
  assert.deepEqual(result.value, scheduleCreateInputSchema.parse(input));
});

test("recurrence variants map to the unchanged Core contract and discard only declared null defaults", () => {
  assert.deepEqual(
    toScheduleCreateRequest(
      scheduleCreateInputSchema.parse({
        ...defaults,
        recurrence: { kind: "interval", every: "1m" },
        startAt: "2099-01-01T14:20",
        rounds: 2,
      }),
    ),
    { name: "probe", prompt: "noop", every: "1m", startAt: "2099-01-01T14:20", rounds: 2 },
  );
  assert.deepEqual(
    toScheduleCreateRequest(
      scheduleCreateInputSchema.parse({
        ...defaults,
        recurrence: { kind: "daily", time: "14:20", timeZone: null },
      }),
    ),
    { name: "probe", prompt: "noop", calendar: { frequency: "daily", time: "14:20" } },
  );
  assert.deepEqual(
    toScheduleCreateRequest(
      scheduleCreateInputSchema.parse({
        ...defaults,
        recurrence: {
          kind: "weekly",
          time: "08:00",
          weekdays: [5, 1, 1],
          timeZone: "Asia/Shanghai",
        },
      }),
    ),
    {
      name: "probe",
      prompt: "noop",
      calendar: { frequency: "weekly", time: "08:00", weekdays: [1, 5], timeZone: "Asia/Shanghai" },
    },
  );
});

test("missing or mixed recurrence variants and legacy fields are invalid before admission", async () => {
  const schema = asSchema(modelTool().inputSchema);
  assert.ok(schema.validate);
  for (const recurrence of [
    null,
    {},
    { kind: "interval" },
    { kind: "interval", every: "1m", time: "14:20" },
    { kind: "daily", time: "14:20", timeZone: null, every: "1d" },
    { kind: "weekly", time: "14:20", timeZone: null },
    { kind: "weekly", time: "14:20", timeZone: null, weekdays: [0] },
    { kind: "daily", time: "24:00", timeZone: null },
    { kind: "daily", time: "14:20", timeZone: "Not/AZone" },
  ]) {
    assert.equal(
      (await schema.validate({ ...defaults, recurrence })).success,
      false,
      JSON.stringify(recurrence),
    );
  }
  assert.equal(
    (
      await schema.validate({
        ...defaults,
        recurrence: { kind: "interval", every: "1m" },
        calendar: {},
      })
    ).success,
    false,
  );
});
