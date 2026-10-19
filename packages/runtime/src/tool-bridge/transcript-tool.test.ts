import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage, ToolExecutionOptions } from "ai";
import { z } from "zod";
import {
  ThreadStore,
  type CheckpointTranscriptPage,
  type ReadCheckpointTranscriptOptions,
} from "../store/thread-store.ts";
import {
  TRANSCRIPT_TOOL_ID,
  buildTranscriptToolset,
  executeTranscriptTool,
  type TranscriptReader,
  type TranscriptToolInput,
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

const transcriptChunkSchema = z.object({
  checkpointId: z.string(),
  kind: z.enum(["message", "tool_execution"]),
  sequence: z.number(),
  offset: z.number(),
  text: z.string(),
  totalChars: z.number(),
  nextOffset: z.number().optional(),
});

function singleMessagePage(message: ModelMessage): CheckpointTranscriptPage {
  return {
    ...messagePage(),
    entries: [
      {
        kind: "message",
        sequence: 0,
        provenance: "native",
        createdAt: "2026-07-17T09:58:00.000Z",
        message,
      },
    ],
  };
}

function readAllChunks(reader: TranscriptReader, input: TranscriptToolInput): string {
  let offset = 0;
  let text = "";
  for (let count = 0; count < 500; count++) {
    const result = executeTranscriptTool(reader, { ...input, offset });
    assert.equal(result.outcome.kind, "success", String(result.display));
    assert.ok(JSON.stringify(result.raw).length <= 30_000);
    assert.ok(JSON.stringify(result.model).length <= 31_000);
    const chunk = transcriptChunkSchema.parse(result.raw);
    assert.equal(chunk.offset, offset);
    text += chunk.text;
    if (chunk.nextOffset === undefined) {
      assert.equal(text.length, chunk.totalChars);
      return text;
    }
    assert.equal(chunk.nextOffset, offset + chunk.text.length);
    assert.ok(chunk.nextOffset > offset);
    offset = chunk.nextOffset;
  }
  assert.fail("chunk reads did not finish");
}

test("Transcript 分块读到长消息中间和尾部，整条先脱敏且 offset 可重复", () => {
  const content = [
    "a".repeat(6_500),
    "visible-middle-fact",
    `password=${"boundary-secret".repeat(900)}`,
    "b".repeat(7_000),
    "visible-tail-fact",
  ].join("\n");
  const page = singleMessagePage({ role: "user", content });
  const seen: ReadCheckpointTranscriptOptions[] = [];
  const reader: TranscriptReader = (options) => {
    seen.push(options);
    return page;
  };
  const input = { checkpointId: CHECKPOINT_ID, sequence: 0, maxChars: 997 };
  const first = executeTranscriptTool(reader, input);
  assert.deepEqual(executeTranscriptTool(reader, input).raw, first.raw);
  const text = readAllChunks(reader, input);
  assert.match(text, /visible-middle-fact/u);
  assert.match(text, /visible-tail-fact/u);
  assert.doesNotMatch(text, /boundary-secret|clipped/u);
  assert.deepEqual(JSON.parse(text), {
    provenance: "native",
    createdAt: "2026-07-17T09:58:00.000Z",
    role: "user",
    content: content.replace(/password=[^\n]*/u, "password=[redacted]"),
  });
  assert.ok(seen.every((options) => options.afterSequence === -1 && options.limit === 1));
  const end = executeTranscriptTool(reader, { ...input, offset: text.length });
  assert.equal(transcriptChunkSchema.parse(end.raw).text, "");
  assert.equal(transcriptChunkSchema.parse(end.raw).nextOffset, undefined);
});

test("Transcript 分块不受分页预览的数组、键数量、嵌套深度限制", () => {
  let nested: Record<string, JSONValue> = { deepFact: "deep-visible-fact" };
  for (let depth = 0; depth < 20; depth++) nested = { child: nested };
  const value = {
    rows: Array.from({ length: 50 }, (_, index) => ({ text: `row-${String(index)}` })),
    fields: Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`field-${String(index)}`, index]),
    ),
    nested,
    password: "hidden-password",
    raw: { text: "hidden-raw" },
    _meta: { text: "hidden-meta" },
    providerOptions: { text: "hidden-provider-options" },
  };
  const message: ModelMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "large-result",
        toolName: "lookup",
        output: { type: "json", value },
      },
    ],
  };
  const reader: TranscriptReader = () => singleMessagePage(message);
  const preview = JSON.stringify(
    executeTranscriptTool(reader, { checkpointId: CHECKPOINT_ID }).raw,
  );
  assert.doesNotMatch(preview, /row-49|field-69|deep-visible-fact/u);
  const text = readAllChunks(reader, { checkpointId: CHECKPOINT_ID, sequence: 0, maxChars: 500 });
  assert.match(text, /row-49/u);
  assert.match(text, /field-69/u);
  assert.match(text, /deep-visible-fact/u);
  assert.doesNotMatch(text, /hidden-password|hidden-raw|hidden-meta|hidden-provider-options/u);
});

test("Transcript 分块保留 typed tool execution 脱敏投影的长尾和 binary omission", () => {
  const record = createToolExecutionRecord({
    toolCallId: "long-tool-result",
    agentName: "demo",
    toolName: "lookup",
    input: { query: "hidden-input" },
    result: successfulToolResult("display", {
      raw: { text: "hidden-raw" },
      model: {
        type: "text",
        value: `${"x".repeat(12_000)}\nvisible-tool-tail\npassword=hidden-secret`,
      },
    }),
  });
  const reader: TranscriptReader = () => ({
    ...toolPage(),
    entries: [{ ...record, kind: "tool_execution", sequence: 2 }],
  });
  const text = readAllChunks(reader, {
    checkpointId: CHECKPOINT_ID,
    kind: "tool_execution",
    sequence: 2,
    maxChars: 701,
  });
  assert.match(text, /visible-tool-tail/u);
  assert.doesNotMatch(text, /hidden-input|hidden-raw|hidden-secret|clipped/u);

  const binaryReader: TranscriptReader = () =>
    singleMessagePage({
      role: "user",
      content: [
        { type: "text", text: "inline data:image/png;base64,c2VjcmV0LWJpbmFyeQ== public-tail" },
        { type: "image", image: Buffer.from("hidden-image-bytes") },
        { type: "image", image: "cGxhaW4taW1hZ2U=" },
      ],
    });
  const binaryText = readAllChunks(binaryReader, { checkpointId: CHECKPOINT_ID, sequence: 0 });
  assert.match(binaryText, /binary data omitted/u);
  assert.match(binaryText, /public-tail/u);
  assert.doesNotMatch(binaryText, /c2VjcmV0|hidden-image-bytes|104,105|cGxhaW4taW1hZ2U/u);
});

test("Transcript 分块严格匹配 checkpoint/kind/sequence，缺失来源不替读后续记录", () => {
  for (const page of [
    { ...messagePage(), entries: [] },
    { ...messagePage(), entries: messagePage().entries.slice(1) },
    { ...messagePage(), checkpointId: PREVIOUS_ID as CheckpointTranscriptPage["checkpointId"] },
    toolPage(),
  ]) {
    const result = executeTranscriptTool(() => page, { checkpointId: CHECKPOINT_ID, sequence: 0 });
    assert.equal(result.outcome.kind, "invalid_input");
    assert.match(String(result.display), /不存在或不属于/u);
  }
  const denied = executeTranscriptTool(
    () => {
      throw new Error("checkpoint 不属于当前 thread");
    },
    {
      checkpointId: CHECKPOINT_ID,
      sequence: 0,
    },
  );
  assert.equal(denied.outcome.kind, "invalid_input");
  assert.match(String(denied.display), /不属于当前 thread/u);
});

test("Transcript 分块参数校验拒绝混用分页参数、越界 offset 和无界请求", () => {
  for (const extra of [
    { offset: 0 },
    { maxChars: 100 },
    { sequence: 0, limit: 1 },
    { sequence: 0, afterSequence: 0 },
    { sequence: -1 },
    { sequence: 0.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: 0, offset: -1 },
    { sequence: 0, maxChars: 8_001 },
    { sequence: 0, maxChars: 0 },
    { limit: 21 },
  ]) {
    let reads = 0;
    const result = executeTranscriptTool(
      () => {
        reads++;
        return messagePage();
      },
      {
        checkpointId: CHECKPOINT_ID,
        ...extra,
      },
    );
    assert.equal(result.outcome.kind, "invalid_input");
    assert.equal(reads, 0);
  }
  const result = executeTranscriptTool(() => messagePage(), {
    checkpointId: CHECKPOINT_ID,
    sequence: 0,
    offset: 100_000,
  });
  assert.equal(result.outcome.kind, "invalid_input");
  assert.match(String(result.display), /offset 超出/u);
});

test("Transcript 分块和分页在 JSON 转义后仍有界且保留续读指针", () => {
  const content = '"\\\n'.repeat(12_000);
  const reader: TranscriptReader = () => singleMessagePage({ role: "user", content });
  const text = readAllChunks(reader, { checkpointId: CHECKPOINT_ID, sequence: 0, maxChars: 8_000 });
  assert.equal(z.object({ content: z.string() }).parse(JSON.parse(text)).content, content);
  const page = singleMessagePage({ role: "user", content });
  const entry = page.entries[0];
  assert.ok(entry);
  const result = executeTranscriptTool(
    () => ({
      ...page,
      entries: Array.from({ length: 20 }, (_, sequence) => ({ ...entry, sequence })),
    }),
    { checkpointId: CHECKPOINT_ID, limit: 20 },
  );
  assert.ok(JSON.stringify(result.raw).length <= 30_000);
  const safePage = z
    .object({ entries: z.array(z.object({ sequence: z.number() })), nextAfterSequence: z.number() })
    .parse(result.raw);
  assert.ok(safePage.entries.length < 20);
  assert.equal(safePage.nextAfterSequence, safePage.entries.at(-1)?.sequence);
});

test("Transcript 分块通过绑定 thread 的真实 reader 保持 checkpoint 隔离与范围", () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-transcript-chunks-"));
  const store = new ThreadStore(directory);
  try {
    const threadId = store.createThread();
    const otherThreadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: `${"x".repeat(10_000)}visible-original-tail` },
    ]);
    const checkpoint = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "任务摘要" }],
      expectedActiveMessages: store.getMessages(threadId),
      expectedLatestCheckpointId: undefined,
      summary: "当前目标：回查压缩前的长原文。下一步：按需读取记录尾部的任务细节。",
    });
    store.appendMessages(threadId, [{ role: "user", content: "after-checkpoint-private-detail" }]);
    const input = { checkpointId: checkpoint.id, sequence: 0 };
    const text = readAllChunks(
      (options) => store.readCheckpointTranscript(threadId, options),
      input,
    );
    assert.match(text, /visible-original-tail/u);
    const otherThread = executeTranscriptTool(
      (options) => store.readCheckpointTranscript(otherThreadId, options),
      input,
    );
    assert.equal(otherThread.outcome.kind, "invalid_input");
    assert.match(String(otherThread.display), /不属于当前 thread/u);
    const outsideCheckpoint = executeTranscriptTool(
      (options) => store.readCheckpointTranscript(threadId, options),
      {
        ...input,
        sequence: 1,
      },
    );
    assert.equal(outsideCheckpoint.outcome.kind, "invalid_input");
    assert.doesNotMatch(JSON.stringify(outsideCheckpoint), /after-checkpoint-private-detail/u);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
