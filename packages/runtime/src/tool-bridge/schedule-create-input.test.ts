import assert from "node:assert/strict";
import test from "node:test";
import { asSchema } from "ai";
import { buildScheduleToolset, SCHEDULE_CREATE_TOOL_ID } from "./schedule-tool.ts";
import { ToolRegistry } from "./naming.ts";
import { scheduleCreateInputSchema, toScheduleCreateRequest } from "./schedule-create-input.ts";
import { createProviderModel } from "@roll-agent/core/llm/providers";

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

function assertStrictObjects(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach(assertStrictObjects);
    return;
  }
  if ("type" in value && value.type === "object") {
    assert.ok(
      "properties" in value && typeof value.properties === "object" && value.properties !== null,
    );
    assert.ok("required" in value && Array.isArray(value.required));
    assert.deepEqual([...value.required].sort(), Object.keys(value.properties).sort());
    assert.ok("additionalProperties" in value && value.additionalProperties === false);
  }
  Object.values(value).forEach(assertStrictObjects);
}

test("OpenAI Responses wire keeps explicit strict and nested recurrence; returned parameters validate", async () => {
  const tool = modelTool();
  const schema = asSchema(tool.inputSchema);
  const jsonSchema = await schema.jsonSchema;
  assertStrictObjects(jsonSchema);
  assert.ok(jsonSchema.properties?.recurrence);
  assert.equal(jsonSchema.properties?.every, undefined);
  assert.equal(jsonSchema.properties?.calendar, undefined);
  const input = {
    ...defaults,
    recurrence: { kind: "interval", every: "1m" },
    startAt: "2099-01-01T14:20",
    rounds: 2,
  };
  const originalFetch = globalThis.fetch;
  let captured = false;
  try {
    globalThis.fetch = async (url, init) => {
      captured = true;
      assert.match(String(url), /\/responses$/u);
      assert.equal(typeof init?.body, "string");
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(
        typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools),
      );
      const wire: unknown = body.tools[0];
      assert.ok(
        typeof wire === "object" && wire !== null && "strict" in wire && wire.strict === true,
      );
      assert.ok("parameters" in wire);
      assert.deepEqual(wire.parameters, jsonSchema);
      return Response.json({
        id: "resp_fixture",
        created_at: 1,
        model: "fixture",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_fixture",
            call_id: "call_fixture",
            name: SCHEDULE_CREATE_TOOL_ID,
            arguments: JSON.stringify(input),
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    };
    const result = await createProviderModel(
      "openai",
      "fixture",
      "fixture-key",
      "http://127.0.0.1:1/v1",
    ).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
      tools: [
        {
          type: "function",
          name: SCHEDULE_CREATE_TOOL_ID,
          inputSchema: jsonSchema,
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      ],
    });
    const call = result.content.find((part) => part.type === "tool-call");
    assert.ok(call);
    assert.deepEqual(JSON.parse(call.input), input);
    assert.ok(schema.validate);
    assert.equal((await schema.validate(JSON.parse(call.input))).success, true);
    assert.equal(captured, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
