import assert from "node:assert/strict";
import test from "node:test";
import { asSchema, stepCountIs, streamText } from "ai";
import { buildScheduleToolset, SCHEDULE_CREATE_TOOL_ID, ToolRegistry } from "@roll-agent/runtime";
import { createProviderModel } from "../llm/providers.ts";

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

function assertStrictObjects(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach(assertStrictObjects);
    return;
  }
  assert.equal("oneOf" in value, false, "OpenAI tool parameters must not contain oneOf");
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
      assertStrictObjects(wire.parameters);
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

for (const stringifyRecurrence of [false, true]) {
  test(`DeepSeek streaming schedule calls retain local validation (string recurrence: ${stringifyRecurrence})`, async () => {
    const scheduleTool = modelTool();
    const input = {
      ...defaults,
      recurrence: stringifyRecurrence
        ? JSON.stringify({ kind: "interval", every: "30m" })
        : { kind: "interval", every: "30m" },
    };
    const schema = await asSchema(scheduleTool.inputSchema).jsonSchema;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let executions = 0;
    let invalidCalls = 0;
    try {
      globalThis.fetch = async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(typeof body === "object" && body !== null && "tools" in body);
        assert.ok(Array.isArray(body.tools));
        assert.deepEqual(body.tools[0], {
          type: "function",
          function: {
            name: SCHEDULE_CREATE_TOOL_ID,
            description: scheduleTool.description,
            parameters: schema,
            strict: false,
          },
        });
        requests += 1;
        if (requests === 2) {
          assert.ok("messages" in body && Array.isArray(body.messages));
          const assistant: unknown = body.messages.find(
            (message: unknown) =>
              typeof message === "object" && message !== null && "tool_calls" in message,
          );
          assert.ok(typeof assistant === "object" && assistant !== null);
          assert.ok("reasoning_content" in assistant);
          assert.equal(assistant.reasoning_content, "fixture reasoning");
        }
        const deltas =
          requests === 1
            ? [
                { reasoning_content: "fixture reasoning" },
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "fixture-call",
                      type: "function",
                      function: {
                        name: SCHEDULE_CREATE_TOOL_ID,
                        arguments: JSON.stringify(input),
                      },
                    },
                  ],
                },
              ]
            : [{ content: "done" }];
        const chunks = deltas.map((delta) => ({
          id: "fixture",
          created: 1,
          model: "deepseek-flash",
          choices: [{ index: 0, delta, finish_reason: null }],
        }));
        const finish = {
          id: "fixture",
          created: 1,
          model: "deepseek-flash",
          choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        return new Response(
          [...chunks, finish].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const result = streamText({
        model: createProviderModel("deepseek", "deepseek-flash", "test-key"),
        prompt: "Validate the fixture schedule without creating a real task",
        providerOptions: { deepseek: { thinking: { type: "enabled" } } },
        tools: {
          [SCHEDULE_CREATE_TOOL_ID]: {
            description: scheduleTool.description ?? "schedule fixture",
            inputSchema: scheduleTool.inputSchema,
            strict: true,
            execute: async (received) => {
              executions += 1;
              assert.deepEqual(received, input);
              return "fixture accepted";
            },
          },
        },
        stopWhen: stepCountIs(2),
      });
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error;
        if (part.type === "tool-call" && part.invalid) invalidCalls += 1;
      }
      assert.equal(await result.text, "done");
      assert.equal(requests, 2);
      assert.equal(executions, stringifyRecurrence ? 0 : 1);
      assert.equal(invalidCalls, stringifyRecurrence ? 1 : 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const method of ["doGenerate", "doStream"] as const) {
  test(`Anthropic ${method} projects strict schedule constraints and keeps local validation`, async () => {
    const tool = modelTool();
    const schema = asSchema(tool.inputSchema);
    const originalSchema = await schema.jsonSchema;
    const before = structuredClone(originalSchema);
    const originalFetch = globalThis.fetch;
    let captured = false;
    try {
      globalThis.fetch = async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(typeof body === "object" && body !== null && "tools" in body);
        assert.ok(Array.isArray(body.tools));
        const wire: unknown = body.tools[0];
        assert.ok(typeof wire === "object" && wire !== null && "strict" in wire);
        assert.equal(wire.strict, true);
        assert.ok("input_schema" in wire);
        const serialized = JSON.stringify(wire.input_schema);
        // These are grammar restrictions, independent of the schema generator under test.
        assert.doesNotMatch(
          serialized,
          /"(?:maxItems|minLength|maxLength|minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)":/u,
        );
        assert.match(serialized, /maxItems=7/u);
        assert.match(serialized, /"const":"weekly"/u);
        assert.match(serialized, /"minItems":1/u);
        assertStrictObjects(wire.input_schema);
        captured = true;
        return method === "doStream"
          ? new Response("", { headers: { "content-type": "text/event-stream" } })
          : Response.json({
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-5",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
      };
      const result = await createProviderModel("anthropic", "claude-sonnet-5", "fixture-key")[
        method
      ]({
        prompt: [{ role: "user", content: [{ type: "text", text: "我有哪些定时任务" }] }],
        tools: [
          {
            type: "function",
            name: SCHEDULE_CREATE_TOOL_ID,
            inputSchema: originalSchema,
            strict: true,
          },
        ],
      });
      if ("stream" in result) await result.stream.cancel();
      assert.equal(captured, true);
      assert.deepEqual(originalSchema, before);
      assert.ok(schema.validate);
      for (const weekdays of [[1, 2, 3, 4, 5, 6, 7, 1], [0], [8], []]) {
        const parsed = await schema.validate({
          ...defaults,
          recurrence: { kind: "weekly", time: "08:00", timeZone: null, weekdays },
        });
        assert.equal(parsed.success, false, JSON.stringify(weekdays));
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
