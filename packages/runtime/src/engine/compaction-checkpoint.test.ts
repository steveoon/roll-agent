import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  buildCompactionCheckpointReminder,
  projectCompactionCheckpointReminder,
  buildCompactionToolState,
  compactionCheckpointV1Schema,
  createCompactionCheckpoint,
  createCompactionCheckpointDraft,
  createCompactionSummary,
  createEmptyCompactionToolState,
  createSummaryCheckpoint,
  parseCompactionCheckpoint,
  type CompactionCheckpointDraftInput,
} from "./compaction-checkpoint.ts";
import {
  createEmptyCompactionSemanticState,
  replaceCompactionSemanticConstraints,
  replaceCompactionSemanticGoal,
} from "./compaction-semantic-state.ts";
import {
  TOOL_CANCELLATION_EXECUTION_STATES,
  TOOL_OUTCOME_KINDS,
  createToolResult,
  successfulToolResult,
} from "../tool-bridge/normalize-result.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";

const CHECKPOINT_ID = "c41bdaa2-9e08-4aac-a8f0-eb7c6c0ca498";
const PREVIOUS_ID = "302c48af-68a0-4b82-85cc-e8c59cfcdac0";

test("V3 reminder gives recent original user messages precedence over summary authorization claims", () => {
  const checkpoint = createSummaryCheckpoint({
    summary: "Review completed; no repair authorization was found in older history.",
    generation: 1,
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 5 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
  });
  const reminder = buildCompactionCheckpointReminder(checkpoint);
  assert.match(reminder, /Recent original user messages take precedence over this summary/);
  assert.match(reminder, /including task scope and authorization/);
  assert.match(reminder, /Missing details in this summary do not imply missing authorization/);
});

function draft(
  overrides: Partial<CompactionCheckpointDraftInput> = {},
): CompactionCheckpointDraftInput {
  return {
    constraints: [],
    resources: [],
    toolState: createEmptyCompactionToolState(),
    runningWork: [],
    context: {
      cwd: "/workspace",
      stableRuleIds: ["tool-grounding/v1"],
      skills: [{ name: "typescript-magician", source: "project" }],
      explicitSkillNames: [],
    },
    summary: { status: "skipped" },
    ...overrides,
  };
}

test("CompactionCheckpoint V1 保持可读，V2 新写并保留 semantic state", () => {
  const legacy = compactionCheckpointV1Schema.parse({
    ...draft({
      goal: { verbatimRequest: "旧 checkpoint", sourceSequence: 1, status: "active" },
    }),
    version: 1,
    id: PREVIOUS_ID,
    generation: 1,
    createdAt: "2026-07-17T09:00:00.000Z",
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 1 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
  });
  assert.deepEqual(parseCompactionCheckpoint(JSON.parse(JSON.stringify(legacy))), legacy);

  const checkpoint = createCompactionCheckpoint({
    id: CHECKPOINT_ID,
    previousCheckpointId: PREVIOUS_ID,
    generation: 2,
    createdAt: "2026-07-17T10:00:00.000Z",
    draft: draft({
      goal: { verbatimRequest: "修复这个问题", sourceSequence: 4, status: "active" },
    }),
    semanticState: replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
      verbatimRequest: "修复这个问题",
      sourceSequence: 4,
    }),
    transcript: {
      messages: { fromSequenceExclusive: 2, throughSequence: 7 },
      toolExecutions: { fromSequenceExclusive: 0, throughSequence: 3 },
      completeness: "complete",
    },
  });

  assert.equal(checkpoint.version, 2);
  assert.equal(checkpoint.id, CHECKPOINT_ID);
  assert.equal(checkpoint.previousCheckpointId, PREVIOUS_ID);
  assert.equal(checkpoint.semanticState.goal?.text, "修复这个问题");
  assert.deepEqual(parseCompactionCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint);
});

test("Checkpoint reminder 注入结构化状态和受控回查入口，不注入 raw transcript", () => {
  const currentManagerInstanceId = "83500e19-0ee3-4721-9ddb-58a8945aa7aa";
  const semanticState = replaceCompactionSemanticConstraints(
    replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
      verbatimRequest: "修复 checkpoint 后继续任务",
      sourceSequence: 7,
    }),
    [{ quote: "不要重复副作用", sourceSequence: 7 }],
  );
  const checkpoint = createCompactionCheckpoint({
    id: CHECKPOINT_ID,
    generation: 3,
    createdAt: "2026-07-17T10:00:00.000Z",
    draft: draft({
      goal: { verbatimRequest: "修复 checkpoint 后继续任务", sourceSequence: 7, status: "active" },
      constraints: [{ quote: "不要重复副作用", sourceSequence: 7 }],
      toolState: {
        ...createEmptyCompactionToolState(),
        countsByOutcome: {
          ...createEmptyCompactionToolState().countsByOutcome,
          cancelled: 1,
          tool_failed: 1,
        },
        recentRecords: [
          {
            executionId: "2410ef09-e409-4209-a33e-8baeee665e4a",
            sequence: 4,
            toolCallId: "call-secret",
            agentName: "demo",
            toolName: "exec",
            outcome: { kind: "tool_failed", reason: "secret-outcome-reason" },
          },
          {
            executionId: "379a4c56-7823-4695-89cf-c72bb6e74cca",
            sequence: 5,
            toolCallId: "call-cancelled",
            agentName: "demo",
            toolName: "exec",
            outcome: {
              kind: "cancelled",
              reason: "user",
              executionState: "not_executed",
            },
          },
        ],
      },
      runningWork: [
        {
          managerInstanceId: currentManagerInstanceId,
          sessionId: 11,
          state: "running",
          recoverability: "live",
          commandPreview: "pnpm test --token secret-command",
          workdir: "/workspace",
          observedAt: "2026-07-17T10:00:00.000Z",
        },
        {
          managerInstanceId: "a89423eb-67dd-4759-958b-d844891fcd9e",
          sessionId: 12,
          state: "running",
          recoverability: "live",
          commandPreview: "pnpm typecheck",
          workdir: "/workspace",
          observedAt: "2026-07-17T10:00:00.000Z",
        },
      ],
    }),
    semanticState,
    transcript: {
      messages: { fromSequenceExclusive: 3, throughSequence: 7 },
      toolExecutions: { fromSequenceExclusive: 1, throughSequence: 4 },
      completeness: "complete",
    },
  });

  const reminder = buildCompactionCheckpointReminder(
    checkpoint,
    currentManagerInstanceId,
    "roll__transcript",
  );
  assert.match(reminder, new RegExp(CHECKPOINT_ID, "u"));
  assert.match(reminder, /"generation":3/u);
  assert.match(reminder, /"semanticState":\{"version":1/u);
  assert.match(reminder, /"omittedCounts"/u);
  assert.match(reminder, /"verbatimRequest":"修复 checkpoint 后继续任务"/u);
  assert.match(reminder, /"quote":"不要重复副作用"/u);
  assert.match(reminder, /"managerMatch":"current"/u);
  assert.match(reminder, /"managerMatch":"foreign"/u);
  assert.match(reminder, /"recoverability":"live"/u);
  assert.match(reminder, /"recoverability":"stale"/u);
  assert.match(reminder, /"executionState":"not_executed"/u);
  assert.match(reminder, /roll__transcript/u);
  assert.match(reminder, /kind="message".*kind="tool_execution"/u);
  assert.ok(reminder.length <= 8_000);
  assert.doesNotMatch(
    reminder,
    /message_json|record_json|raw transcript content|secret-command|secret-outcome-reason/u,
  );

  const unavailable = buildCompactionCheckpointReminder(checkpoint, currentManagerInstanceId);
  assert.match(unavailable, /入口当前不可用|未提供可用的 transcript tool/u);
  assert.doesNotMatch(unavailable, /roll__transcript/u);

  const invalidId = buildCompactionCheckpointReminder(
    checkpoint,
    currentManagerInstanceId,
    "not a registered tool",
  );
  assert.match(invalidId, /未提供可用的 transcript tool/u);
  assert.doesNotMatch(invalidId, /not a registered tool/u);
});

test("V2 checkpoint 拒绝与 semanticState 矛盾的兼容 goal/constraints 投影", () => {
  const semanticState = replaceCompactionSemanticConstraints(
    replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
      verbatimRequest: "修复调度器",
      sourceSequence: 4,
    }),
    [{ quote: "不要修改公开 API", sourceSequence: 4 }],
  );
  const checkpoint = createCompactionCheckpoint({
    generation: 1,
    draft: draft({
      goal: { verbatimRequest: "修复调度器", sourceSequence: 4, status: "active" },
      constraints: [{ quote: "不要修改公开 API", sourceSequence: 4 }],
    }),
    semanticState,
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 4 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
  });

  assert.throws(
    () =>
      parseCompactionCheckpoint({
        ...checkpoint,
        goal: { verbatimRequest: "部署生产", sourceSequence: 4, status: "active" },
      }),
    /Invalid persisted compaction checkpoint/u,
  );
  assert.throws(
    () => parseCompactionCheckpoint({ ...checkpoint, constraints: [] }),
    /Invalid persisted compaction checkpoint/u,
  );
});

test("Checkpoint reminder 对完整 payload 施加硬预算并显式报告省略项", () => {
  const checkpoint = createCompactionCheckpoint({
    generation: 1,
    draft: draft({
      resources: Array.from({ length: 32 }, (_, index) => ({
        key: `${String(index)}:${"x".repeat(100_000)}`,
        mode: "write",
        evidenceToolCallId: `call-${String(index)}`,
        evidenceExecutionId: `2410ef09-e409-4209-a33e-${String(index).padStart(12, "0")}`,
      })),
    }),
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: -1 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
  });

  const reminder = buildCompactionCheckpointReminder(checkpoint);
  assert.ok(reminder.length <= 8_000);
  assert.match(reminder, /"resources":24/u);
  assert.doesNotMatch(reminder, /x{2000}/u);
});

test("CompactionCheckpoint 拒绝回退的 transcript high watermark 和未知版本", () => {
  assert.throws(
    () =>
      createCompactionCheckpoint({
        generation: 1,
        draft: draft(),
        transcript: {
          messages: { fromSequenceExclusive: 5, throughSequence: 4 },
          toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
          completeness: "complete",
        },
      }),
    /throughSequence/u,
  );

  const checkpoint = createCompactionCheckpoint({
    generation: 1,
    draft: draft(),
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: -1 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
  });
  assert.throws(
    () => parseCompactionCheckpoint({ ...checkpoint, version: 99 }),
    /Unsupported compaction checkpoint version/u,
  );
});

test("Tool state 只信 typed outcome，不从误导 display 推断", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "write", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "write",
          output: { type: "text", value: "看起来成功" },
        },
      ],
    },
  ];
  const record = createToolExecutionRecord({
    id: "5f58a2e2-a7c6-4523-834c-5716924d3337",
    toolCallId: "call-1",
    agentName: "demo",
    toolName: "write",
    input: {},
    result: createToolResult(
      {
        kind: TOOL_OUTCOME_KINDS.cancelled,
        reason: "user",
        executionState: TOOL_CANCELLATION_EXECUTION_STATES.notExecuted,
      },
      "执行成功",
    ),
  });

  const state = buildCompactionToolState(messages, [{ ...record, sequence: 8 }]);
  assert.equal(state.countsByOutcome.cancelled, 1);
  assert.equal(state.countsByOutcome.success, 0);
  assert.equal(state.recentRecords[0]?.outcome.kind, TOOL_OUTCOME_KINDS.cancelled);
  assert.equal(
    state.recentRecords[0]?.outcome.executionState,
    TOOL_CANCELLATION_EXECUTION_STATES.notExecuted,
  );
  assert.equal(state.integrityStatus, "valid");
  assert.equal(
    buildCompactionToolState(messages, [{ ...record, sequence: 8 }], 0).recentRecords.length,
    0,
  );

  const legacyState = buildCompactionToolState(
    messages,
    [{ ...record, sequence: 8 }],
    32,
    "legacy_snapshot",
  );
  assert.equal(legacyState.integrityStatus, "sanitized");
});

test("Tool integrity 报告 orphan/result-without-record，不伪造成功", () => {
  const messages: ModelMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "orphan",
          toolName: "lookup",
          output: { type: "text", value: "ok" },
        },
      ],
    },
  ];
  const unrelated = createToolExecutionRecord({
    id: "6bad933a-539e-43b8-9004-7a8a00556885",
    toolCallId: "historical-call",
    agentName: "demo",
    toolName: "lookup",
    input: {},
    result: successfulToolResult("ok"),
  });

  const state = buildCompactionToolState(messages, [{ ...unrelated, sequence: 1 }]);
  assert.equal(state.integrityStatus, "invalid");
  assert.deepEqual(
    state.anomalies.map((anomaly) => anomaly.kind),
    ["record_without_call", "orphan_result", "result_without_record"],
  );
});

test("Summary correctness 只拒绝空内容，语言无关的质量提示不参与恢复门禁", () => {
  assert.deepEqual(createCompactionSummary(""), {
    status: "fallback",
    reason: "empty summary",
  });
  assert.equal(createCompactionSummary("太短").status, "valid");
  assert.equal(
    createCompactionSummary(
      "現在の作業を安全に継続し、保存済みの制約と検証結果を確認してから次の変更を実施する。",
    ).status,
    "valid",
  );
  const valid = createCompactionSummary(
    "当前目标：完成 checkpoint。关键约束：保持旧 thread 可读。下一步：执行聚焦测试并校验 transcript。",
  );
  assert.equal(valid.status, "valid");
  assert.match(valid.digest ?? "", /^[0-9a-f]{64}$/u);
});

test("Draft schema 拒绝把未知 Tool outcome 写入持久化 checkpoint", () => {
  assert.throws(
    () =>
      createCompactionCheckpointDraft({
        ...draft(),
        toolState: {
          ...createEmptyCompactionToolState(),
          recentRecords: [
            {
              executionId: "d2df3c50-10de-4efd-9199-a0f7d5dd323c",
              sequence: 1,
              toolCallId: "x",
              agentName: "a",
              toolName: "t",
              outcome: { kind: "invented" },
            },
          ],
        },
      } as unknown as CompactionCheckpointDraftInput),
    /Invalid enum value/u,
  );

  assert.throws(
    () =>
      createCompactionCheckpointDraft({
        ...draft(),
        toolState: {
          ...createEmptyCompactionToolState(),
          recentRecords: [
            {
              executionId: "d2df3c50-10de-4efd-9199-a0f7d5dd323c",
              sequence: 1,
              toolCallId: "x",
              agentName: "a",
              toolName: "t",
              outcome: {
                kind: "cancelled",
                executionState: "invented",
              },
            },
          ],
        },
      } as unknown as CompactionCheckpointDraftInput),
    /Invalid enum value|Invalid option/u,
  );
});

for (const memo of [undefined, "Recovered context: " + '\\"\n🧭'.repeat(550)]) {
  test(`whole reminder bounds escaped facts, metadata and recovery memo (${memo?.length ?? 0})`, () => {
    const constraints = Array.from({ length: 40 }, (_, i) => ({
      quote: `constraint ${i}: ` + '\\"\n🧭'.repeat(50),
      sourceSequence: i,
    }));
    const state = replaceCompactionSemanticConstraints(
      createEmptyCompactionSemanticState(),
      constraints,
    );
    const checkpoint = createCompactionCheckpoint({
      generation: 9,
      draft: draft({
        constraints: state.constraints.map((item) => ({
          quote: item.text,
          sourceSequence: item.provenance[0]!.messageSequence!,
        })),
      }),
      semanticState: state,
      transcript: {
        messages: { fromSequenceExclusive: -1, throughSequence: 39 },
        toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
        completeness: "complete",
      },
    });
    const result = projectCompactionCheckpointReminder(
      checkpoint,
      undefined,
      "roll__transcript",
      "roll__context",
      memo,
    );
    assert.ok(result.text.length <= 8000, String(result.text.length));
    assert.match(result.text, /roll__context/u);
    assert.match(result.text, /nextCursor/u);
    assert.match(result.text, /nextOffset/u);
    assert.ok(result.semanticProjection!.omittedCounts.constraint > 0);
    const payload: unknown = JSON.parse(result.text.split("\n")[1]!);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(payload, "semanticState")?.value,
      result.semanticProjection,
      "retention checks use the actual serialized projection",
    );
  });
}
