import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  buildCompactionCheckpointReminder,
  buildCompactionToolState,
  createCompactionCheckpoint,
  createCompactionCheckpointDraft,
  createCompactionSummary,
  createEmptyCompactionToolState,
  extractExplicitCompactionConstraintCandidates,
  findLatestRealUserGoal,
  parseCompactionCheckpoint,
  resolveActiveCompactionConstraints,
  verifyCompactionConstraintCandidates,
  type ArchivedTranscriptMessage,
  type CompactionCheckpointDraftInput,
} from "./compaction-checkpoint.ts";
import { SUMMARY_PREFIX } from "./compactor.ts";
import { attachExplicitSkillCheckpoint } from "./explicit-skill-context.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
} from "../tool-bridge/normalize-result.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";

const CHECKPOINT_ID = "c41bdaa2-9e08-4aac-a8f0-eb7c6c0ca498";
const PREVIOUS_ID = "302c48af-68a0-4b82-85cc-e8c59cfcdac0";

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

function transcript(
  sequence: number,
  message: ModelMessage,
  provenance: ArchivedTranscriptMessage["provenance"] = "native",
): ArchivedTranscriptMessage {
  return {
    sequence,
    provenance,
    createdAt: "2026-07-17T10:00:00.000Z",
    message,
  };
}

test("CompactionCheckpoint v1 round-trip 保留 version、previous 与双 transcript range", () => {
  const checkpoint = createCompactionCheckpoint({
    id: CHECKPOINT_ID,
    previousCheckpointId: PREVIOUS_ID,
    generation: 2,
    createdAt: "2026-07-17T10:00:00.000Z",
    draft: draft({
      goal: { verbatimRequest: "修复这个问题", sourceSequence: 4, status: "active" },
    }),
    transcript: {
      messages: { fromSequenceExclusive: 2, throughSequence: 7 },
      toolExecutions: { fromSequenceExclusive: 0, throughSequence: 3 },
      completeness: "complete",
    },
  });

  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.id, CHECKPOINT_ID);
  assert.equal(checkpoint.previousCheckpointId, PREVIOUS_ID);
  assert.deepEqual(parseCompactionCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint);
});

test("Checkpoint reminder 注入结构化状态和受控回查入口，不注入 raw transcript", () => {
  const currentManagerInstanceId = "83500e19-0ee3-4721-9ddb-58a8945aa7aa";
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
  assert.match(reminder, /"verbatimRequest":"修复 checkpoint 后继续任务"/u);
  assert.match(reminder, /"quote":"不要重复副作用"/u);
  assert.match(reminder, /"managerMatch":"current"/u);
  assert.match(reminder, /"managerMatch":"foreign"/u);
  assert.match(reminder, /"recoverability":"live"/u);
  assert.match(reminder, /"recoverability":"stale"/u);
  assert.match(reminder, /roll__transcript/u);
  assert.match(reminder, /kind="message".*kind="tool_execution"/u);
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
    /Invalid persisted compaction checkpoint/u,
  );
});

test("findLatestRealUserGoal 跳过无信息续接与 legacy summary，并读取显式 Skill 的真实 userPrompt", () => {
  const explicit = attachExplicitSkillCheckpoint(
    { role: "user", content: "/skill 修一下" },
    {
      userPrompt: "修一下类型，并且不要改 API",
      modelUserContent: "[Skill content]\n...\n[User request]\n修一下类型，并且不要改 API",
      skillNames: ["skill"],
    },
  );
  const entries = [
    transcript(0, { role: "user", content: "旧目标" }),
    transcript(1, explicit),
    transcript(
      2,
      { role: "user", content: `${SUMMARY_PREFIX}\n\n这是历史摘要` },
      "legacy_snapshot",
    ),
    transcript(3, { role: "user", content: "继续" }),
    transcript(4, { role: "user", content: "继续处理" }),
  ];

  assert.deepEqual(findLatestRealUserGoal(entries), {
    verbatimRequest: "修一下类型，并且不要改 API",
    sourceSequence: 1,
    status: "active",
  });
});

test("findLatestRealUserGoal 跳过仅含礼貌确认前缀的续接，但保留携带新信息的请求", () => {
  const original = transcript(0, { role: "user", content: "修复调度器" });
  const informationFree = [
    "OK，继续",
    "好的，继续吧",
    "嗯 接着做",
    "收到，那继续处理",
    "Okay, proceed with it",
  ];
  for (const content of informationFree) {
    assert.deepEqual(
      findLatestRealUserGoal([original, transcript(2, { role: "user", content })]),
      { verbatimRequest: "修复调度器", sourceSequence: 0, status: "active" },
      content,
    );
  }

  const substantive = [
    "OK，继续修复 X",
    "好的，继续，但不要改 API",
    "嗯 接着做，并补测试",
    "OKR，继续",
    "继续处理资源排序",
  ];
  for (const content of substantive) {
    assert.deepEqual(
      findLatestRealUserGoal([original, transcript(2, { role: "user", content })]),
      { verbatimRequest: content, sourceSequence: 2, status: "active" },
      content,
    );
  }
});

test("显式约束只从 transcript 原文 clause 提取，普通目标与无信息续接不冒充 constraint", () => {
  const entries = [
    transcript(0, {
      role: "user",
      content: "修复调度器，但绝对不要修改公开 API；必须保留现有 CLI 行为。",
    }),
    transcript(2, { role: "user", content: "继续" }),
    transcript(4, { role: "user", content: "补齐回归测试" }),
  ];

  const candidates = extractExplicitCompactionConstraintCandidates(entries);
  assert.deepEqual(candidates, [
    { quote: "绝对不要修改公开 API", sourceSequence: 0 },
    { quote: "必须保留现有 CLI 行为", sourceSequence: 0 },
  ]);
  assert.deepEqual(verifyCompactionConstraintCandidates(entries, candidates), [
    { quote: "必须保留现有 CLI 行为", sourceSequence: 0 },
    { quote: "绝对不要修改公开 API", sourceSequence: 0 },
  ]);
});

test("显式约束 marker regex audit 覆盖 English、CJK 标点、换行与歧义负例", () => {
  const entries = [
    transcript(0, { role: "user", content: "继续处理" }),
    transcript(2, { role: "user", content: "保持进度" }),
    transcript(4, {
      role: "user",
      content: "Fix the scheduler, but must not change the public API.",
    }),
    transcript(6, {
      role: "user",
      content: "不得删除兼容层，\n务必保留现有 CLI 行为。",
    }),
    transcript(8, {
      role: "user",
      content: "mustard and avoidance are ordinary words",
    }),
    transcript(10, { role: "user", content: "不允许修改公开 API。" }),
    transcript(12, { role: "user", content: "不可以删除日志；不再允许改变输出格式。" }),
    transcript(14, {
      role: "user",
      content: "Can you fix the scheduler but must not change the public CLI?",
    }),
    transcript(16, { role: "user", content: "可以帮我继续但不要删除回归测试" }),
  ];

  assert.deepEqual(extractExplicitCompactionConstraintCandidates(entries), [
    { quote: "must not change the public API", sourceSequence: 4 },
    { quote: "不得删除兼容层", sourceSequence: 6 },
    { quote: "务必保留现有 CLI 行为", sourceSequence: 6 },
    { quote: "不允许修改公开 API", sourceSequence: 10 },
    { quote: "不可以删除日志", sourceSequence: 12 },
    { quote: "不再允许改变输出格式", sourceSequence: 12 },
    { quote: "must not change the public CLI", sourceSequence: 14 },
    { quote: "不要删除回归测试", sourceSequence: 16 },
  ]);
});

test("后续同 scope 显式允许会撤销旧约束，旧版整条 goal constraint 不再无条件继承", () => {
  const entries = [
    transcript(0, { role: "user", content: "绝对不要修改公开 API" }),
    transcript(2, { role: "user", content: "继续" }),
    transcript(4, { role: "user", content: "现在允许修改公开 API" }),
  ];

  assert.deepEqual(
    resolveActiveCompactionConstraints(entries, [
      { quote: "修复调度器，但绝对不要修改公开 API", sourceSequence: 0 },
      { quote: "绝对不要修改公开 API", sourceSequence: 0 },
      { quote: "继续", sourceSequence: 2 },
    ]),
    [],
  );
  assert.deepEqual(
    resolveActiveCompactionConstraints([
      transcript(0, { role: "user", content: "绝对不要修改公开 API" }),
      transcript(2, { role: "user", content: "不再要求绝对不要修改公开 API" }),
    ]),
    [],
  );
  assert.deepEqual(
    resolveActiveCompactionConstraints([
      transcript(0, { role: "user", content: "must not modify the public API" }),
      transcript(2, { role: "user", content: "you can modify the public API" }),
    ]),
    [],
  );
});

test("不允许、不可以、不再允许是负约束，不会从内部允许词误判为 revocation", () => {
  const entries = [
    transcript(0, { role: "user", content: "绝对不要修改公开 API" }),
    transcript(2, { role: "user", content: "不允许修改公开 API" }),
  ];

  assert.deepEqual(resolveActiveCompactionConstraints(entries), [
    { quote: "不允许修改公开 API", sourceSequence: 2 },
  ]);
});

test("约束只接受可回指到真实 user message 的原文 quote，并保留上一 checkpoint", () => {
  const entries = [transcript(3, { role: "user", content: "请修复，并且不要改公开 API" })];
  const constraints = verifyCompactionConstraintCandidates(
    entries,
    [
      { quote: "不要改公开 API", sourceSequence: 3 },
      { quote: "已经发布成功", sourceSequence: 3 },
    ],
    [{ quote: "保留旧配置", sourceSequence: 1 }],
  );

  assert.deepEqual(constraints, [
    { quote: "保留旧配置", sourceSequence: 1 },
    { quote: "不要改公开 API", sourceSequence: 3 },
  ]);
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
    result: failedToolResult(TOOL_OUTCOME_KINDS.cancelled, "执行成功"),
  });

  const state = buildCompactionToolState(messages, [{ ...record, sequence: 8 }]);
  assert.equal(state.countsByOutcome.cancelled, 1);
  assert.equal(state.countsByOutcome.success, 0);
  assert.equal(state.recentRecords[0]?.outcome.kind, TOOL_OUTCOME_KINDS.cancelled);
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

test("Summary quality 拒绝空、过短、缺结构与语义空洞，有效摘要只保存 digest", () => {
  assert.deepEqual(createCompactionSummary(""), {
    status: "fallback",
    reason: "empty summary",
  });
  assert.equal(createCompactionSummary("太短").status, "fallback");
  assert.deepEqual(
    createCompactionSummary(
      "已经处理了不少内容，后续继续完成剩余工作即可，不需要关注任何具体细节。",
    ),
    { status: "fallback", reason: "summary lacks structured task state" },
  );
  assert.deepEqual(
    createCompactionSummary(
      "当前目标：继续任务。关键约束：遵守约束。下一步：继续推进。重要证据：查看内容。",
    ),
    { status: "fallback", reason: "summary lacks concrete task evidence" },
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
});
