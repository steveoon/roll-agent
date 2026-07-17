import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecutionOptions } from "ai";
import type {
  CheckpointTranscriptPage,
  ReadCheckpointTranscriptOptions,
} from "../store/thread-store.ts";
import {
  TRANSCRIPT_TOOL_ID,
  buildTranscriptToolset,
  executeTranscriptTool,
  type TranscriptReader,
} from "./transcript-tool.ts";
import { ToolRegistry } from "./naming.ts";
import { createToolExecutionRecord } from "./tool-execution-record.ts";
import { successfulToolResult, type NormalizedToolResult } from "./normalize-result.ts";

const CHECKPOINT_ID = "f67a672b-c254-4832-9c1d-b06f724bd775";
const PREVIOUS_ID = "da661fa2-88eb-42ca-b5f3-efbfdb6c5605";
const EXEC_OPTIONS = {
  toolCallId: "transcript-call",
  messages: [],
} as unknown as ToolExecutionOptions<unknown>;

function messagePage(): CheckpointTranscriptPage {
  return {
    checkpointId: CHECKPOINT_ID as CheckpointTranscriptPage["checkpointId"],
    kind: "message",
    entries: [
      {
        kind: "message",
        sequence: 0,
        provenance: "native",
        createdAt: "2026-07-17T09:58:00.000Z",
        message: {
          role: "user",
          content: [
            "任务背景",
            "password=my secret phrase",
            "密码=中文机密 不能泄漏",
            "AWS_SECRET_ACCESS_KEY=transcript-aws-secret",
            "DATABASE_URL=postgres://transcript-user:transcript-password@localhost/app",
            "PUBLIC_URL=https://public.example.com",
            "用户可见证据",
          ].join("\n"),
        },
      },
      {
        kind: "message",
        sequence: 2,
        provenance: "native",
        createdAt: "2026-07-17T09:59:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "API_KEY=assistant secret phrase",
                "AWS_ACCESS_KEY_ID=transcript-access-key-id",
                "GOOGLE_APPLICATION_CREDENTIALS=/tmp/transcript-google-secret.json",
                "CALLBACK_URL=https://callback.example.com",
                "status=visible-assistant-evidence",
              ].join("\n"),
            },
          ],
        },
      },
      {
        kind: "message",
        sequence: 4,
        provenance: "native",
        createdAt: "2026-07-17T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "lookup",
              input: { token: "secret-input", query: "visible-query" },
            },
          ],
          providerOptions: {
            secretProvider: { apiKey: "secret-provider-option" },
          },
        },
      },
    ],
    nextAfterSequence: 4,
    previousCheckpointId: PREVIOUS_ID as CheckpointTranscriptPage["checkpointId"],
    completeness: "complete",
  };
}

function toolPage(): CheckpointTranscriptPage {
  const record = createToolExecutionRecord({
    id: "ab02e6fe-dd29-471a-9400-14e0e9f47cd2",
    toolCallId: "call-1",
    agentName: "demo",
    toolName: "lookup",
    input: { token: "secret-record-input" },
    result: successfulToolResult("visible-display", {
      raw: {
        structuredContent: { answer: "secret-raw" },
        _meta: { token: "secret-meta" },
      },
      model: { type: "text", value: "visible-model-output" },
    }),
    createdAt: "2026-07-17T10:00:00.000Z",
  });
  return {
    checkpointId: CHECKPOINT_ID as CheckpointTranscriptPage["checkpointId"],
    kind: "tool_execution",
    entries: [{ kind: "tool_execution", sequence: 2, ...record }],
    completeness: "legacy_snapshot",
  };
}

test("Transcript tool message 读取默认隐藏 input、providerOptions 并保留分页指针", () => {
  const seen: ReadCheckpointTranscriptOptions[] = [];
  const reader: TranscriptReader = (options) => {
    seen.push(options);
    return messagePage();
  };

  const result = executeTranscriptTool(reader, { checkpointId: CHECKPOINT_ID });
  const raw = JSON.stringify(result.raw);
  const model = JSON.stringify(result.model);
  assert.equal(result.isError, false);
  assert.deepEqual(seen, [{ checkpointId: CHECKPOINT_ID, kind: "message", limit: 10 }]);
  for (const projection of [raw, model]) {
    assert.match(projection, /call-1/u);
    assert.match(projection, /lookup/u);
    assert.match(projection, /\[redacted\]/u);
    assert.match(
      projection,
      /用户可见证据|visible-assistant-evidence|PUBLIC_URL=https|CALLBACK_URL=https/u,
    );
    assert.doesNotMatch(
      projection,
      /my secret phrase|中文机密|不能泄漏|assistant secret phrase|transcript-aws-secret|transcript-password|transcript-access-key-id|transcript-google-secret|visible-query|secret-input|secret-provider-option/u,
    );
    assert.match(projection, /nextAfterSequence/u);
    assert.match(projection, new RegExp(PREVIOUS_ID, "u"));
  }
});

test("Transcript tool execution 复用 redacted ToolExecutionRecord，不泄露 raw/_meta", () => {
  const result = executeTranscriptTool(() => toolPage(), {
    checkpointId: CHECKPOINT_ID,
    kind: "tool_execution",
  });
  const serialized = JSON.stringify(result.raw);
  assert.equal(result.isError, false);
  assert.match(serialized, /visible-model-output/u);
  assert.match(serialized, /visible-display/u);
  assert.match(serialized, /legacy_snapshot/u);
  assert.doesNotMatch(serialized, /secret-record-input|secret-raw|secret-meta/u);
});

test("Transcript tool 把越权/损坏 checkpoint reader 错误类型化为 invalid_input", () => {
  const result = executeTranscriptTool(
    () => {
      throw new Error("checkpoint 不属于当前 thread");
    },
    { checkpointId: CHECKPOINT_ID },
  );
  assert.equal(result.outcome.kind, "invalid_input");
  assert.match(String(result.display), /不属于当前 thread/u);
});

test("buildTranscriptToolset 注册 roll__transcript 并通过只读 reader 执行", async () => {
  const registry = new ToolRegistry();
  const toolset = buildTranscriptToolset(() => messagePage(), registry);
  assert.equal(TRANSCRIPT_TOOL_ID, "roll__transcript");
  assert.deepEqual(registry.resolve(TRANSCRIPT_TOOL_ID), {
    agentName: "roll",
    toolName: "transcript",
  });

  const execute = toolset[TRANSCRIPT_TOOL_ID]?.execute;
  assert.ok(execute);
  const result = (await execute(
    { checkpointId: CHECKPOINT_ID, kind: "message", limit: 1 },
    EXEC_OPTIONS,
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, "success");
});
