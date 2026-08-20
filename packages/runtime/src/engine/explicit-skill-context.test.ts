import { test } from "node:test";
import assert from "node:assert/strict";
import { modelMessageSchema, type ModelMessage } from "ai";
import type { SkillLibrary, SkillSummary } from "@roll-agent/core/skills/library";
import {
  applyExplicitSkillContext,
  attachExplicitSkillCheckpoint,
  isExplicitSkillCheckpointV1,
  prepareExplicitSkillContext,
  readExplicitSkillCheckpoint,
  sanitizePersistedExplicitSkillCheckpoint,
  stripExplicitSkillCheckpoints,
  type ExplicitSkillContextSnapshot,
} from "./explicit-skill-context.ts";

function checkpointSnapshot(
  name: string,
  userPrompt: string,
  modelUserContent: string,
): ExplicitSkillContextSnapshot {
  return {
    userPrompt,
    modelUserContent,
    skillNames: [name],
    skillReferences: [
      {
        name,
        source: "project",
        contentSha256: "a".repeat(64),
      },
    ],
  };
}

test("prepareExplicitSkillContext 对完整多 Skill 上下文执行 60000 字符硬预算", () => {
  const summaries: readonly SkillSummary[] = [
    { name: "one", description: "first", source: "project" },
    { name: "two", description: "second", source: "user" },
  ];
  const library: SkillLibrary = {
    list: () => summaries,
    load: (name) => {
      const summary = summaries.find((item) => item.name === name);
      return summary
        ? {
            summary,
            content: `${name.toUpperCase()}_${"x".repeat(100_000)}`,
            referencePaths: [],
          }
        : undefined;
    },
    loadReference: () => undefined,
  };

  const snapshot = prepareExplicitSkillContext({
    rawInput: "/one /two execute",
    skillSummaries: summaries,
    skillLibrary: library,
  });
  const [context] = snapshot.modelUserContent.split("\n\n[User request]\n");

  assert.ok(context);
  assert.ok(context.length <= 60_000, `actual context length: ${String(context.length)}`);
  assert.match(context, /"name":"one"/u);
  assert.match(context, /"name":"two"/u);
  assert.doesNotMatch(context, /roll__skill/u);
  assert.equal(snapshot.userPrompt, "execute");
  assert.deepEqual(
    snapshot.skillReferences?.map((skill) => ({
      name: skill.name,
      source: skill.source,
      digestLength: skill.contentSha256.length,
    })),
    [
      { name: "one", source: "project", digestLength: 64 },
      { name: "two", source: "user", digestLength: 64 },
    ],
  );
});

test("prepareExplicitSkillContext 在 metadata 本身超过硬预算时拒绝推理", () => {
  const summaries: readonly SkillSummary[] = Array.from({ length: 1_000 }, (_, index) => ({
    name: `skill-${String(index).padStart(4, "0")}`,
    description: "budget probe",
    source: "project" as const,
  }));
  const library: SkillLibrary = {
    list: () => summaries,
    load: () => {
      throw new Error("metadata 预算失败时不应读取 Skill 正文");
    },
    loadReference: () => undefined,
  };

  assert.throws(
    () =>
      prepareExplicitSkillContext({
        rawInput: `${summaries.map((skill) => `/${skill.name}`).join(" ")} execute`,
        skillSummaries: summaries,
        skillLibrary: library,
      }),
    /metadata 超出 60000 字符上下文预算/u,
  );
});

test("explicit Skill checkpoint JSON roundtrip 只持久化轻量引用，不包含 Skill 正文", () => {
  const snapshot = checkpointSnapshot("demo", "execute", "DEMO_BODY\n\nexecute");
  const attached = attachExplicitSkillCheckpoint(
    {
      role: "user",
      content: "/demo execute",
      providerOptions: {
        openai: { reasoningEffort: "high" },
        rollHarness: { traceId: "trace-1" },
      },
    },
    snapshot,
  );
  const roundtripped = modelMessageSchema.parse(JSON.parse(JSON.stringify(attached)));
  const checkpoint = readExplicitSkillCheckpoint(roundtripped);

  assert.equal(roundtripped.content, "/demo execute");
  assert.ok(checkpoint);
  assert.ok(isExplicitSkillCheckpointV1(checkpoint));
  assert.deepEqual(checkpoint.snapshot, {
    userPrompt: snapshot.userPrompt,
    skillNames: snapshot.skillNames,
    skills: snapshot.skillReferences,
  });
  assert.doesNotMatch(JSON.stringify(roundtripped), /DEMO_BODY/u);
  assert.deepEqual(roundtripped.providerOptions?.openai, { reasoningEffort: "high" });
  assert.equal(
    roundtripped.providerOptions?.rollHarness?.traceId,
    "trace-1",
    "attach 应保留同 namespace 下的其他 Harness metadata",
  );
});

test("readExplicitSkillCheckpoint 兼容旧 v1 checkpoint 并忽略历史正文", () => {
  const legacy: ModelMessage = {
    role: "user",
    content: "/demo legacy",
    providerOptions: {
      rollHarness: {
        explicitSkillCheckpoint: {
          version: 1,
          kind: "explicit-skill",
          snapshot: {
            userPrompt: "legacy",
            modelUserContent: "LEGACY_SKILL_BODY",
            skillNames: ["demo"],
          },
        },
      },
    },
  };

  const checkpoint = readExplicitSkillCheckpoint(legacy);

  assert.equal(checkpoint?.snapshot.userPrompt, "legacy");
  assert.deepEqual(checkpoint?.snapshot.skillNames, ["demo"]);
  assert.doesNotMatch(JSON.stringify(checkpoint), /LEGACY_SKILL_BODY|modelUserContent/u);
});

test("历史 checkpoint 只保留原始输入，当前 Turn Skill context 由内存快照单独应用", () => {
  const first = attachExplicitSkillCheckpoint(
    {
      role: "user",
      content: "/one first",
      providerOptions: { openai: { cache: true } },
    },
    checkpointSnapshot("one", "first", "ONE_BODY\n\nfirst"),
  );
  const future: ModelMessage = {
    role: "user",
    content: "/future request",
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
      rollHarness: {
        explicitSkillCheckpoint: {
          version: 2,
          kind: "explicit-skill",
          snapshot: {
            userPrompt: "request",
            modelUserContent: "FUTURE_BODY",
            skillNames: ["future"],
          },
        },
      },
    },
  };
  const assistantWithHiddenMetadata: ModelMessage = {
    role: "assistant",
    content: "done",
    providerOptions: {
      openai: { itemId: "item-1" },
      rollHarness: { internal: true },
    },
  };

  const stripped = stripExplicitSkillCheckpoints([
    first,
    { role: "assistant", content: "first done" },
    future,
    assistantWithHiddenMetadata,
  ]);
  const currentSnapshot = checkpointSnapshot("two", "second", "TWO_BODY\n\nsecond");
  const materialized = applyExplicitSkillContext(
    [...stripped, { role: "user", content: "/two second" }],
    currentSnapshot,
  );

  assert.equal(materialized[0]?.content, "/one first");
  assert.equal(materialized[2]?.content, "/future request", "未知版本必须安全忽略");
  assert.equal(materialized[4]?.content, "TWO_BODY\n\nsecond");
  assert.equal(first.content, "/one first", "应用当前快照不得改写持久化原消息");
  assert.deepEqual(materialized[0]?.providerOptions, { openai: { cache: true } });
  assert.deepEqual(materialized[2]?.providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
  assert.deepEqual(materialized[3]?.providerOptions, { openai: { itemId: "item-1" } });
  assert.doesNotMatch(JSON.stringify(materialized), /ONE_BODY|FUTURE_BODY|rollHarness/u);
});

test("stripExplicitSkillCheckpoints 保留原始用户输入和其他 provider options", () => {
  const attached = attachExplicitSkillCheckpoint(
    {
      role: "user",
      content: "/demo visible request",
      providerOptions: { anthropic: { effort: "high" } },
    },
    checkpointSnapshot("demo", "visible request", "SECRET_SKILL_BODY"),
  );

  const [visible] = stripExplicitSkillCheckpoints([attached]);

  assert.equal(visible?.content, "/demo visible request");
  assert.deepEqual(visible?.providerOptions, { anthropic: { effort: "high" } });
  assert.ok(attached.providerOptions?.rollHarness, "strip 不得修改内部原消息");
  assert.doesNotMatch(JSON.stringify(visible), /SECRET_SKILL_BODY|rollHarness/u);
});

test("readExplicitSkillCheckpoint 对未知版本和畸形 snapshot 返回 undefined", () => {
  const unknownVersion: ModelMessage = {
    role: "user",
    content: "/demo execute",
    providerOptions: {
      rollHarness: {
        explicitSkillCheckpoint: {
          version: 2,
          kind: "explicit-skill",
          snapshot: {
            userPrompt: "execute",
            modelUserContent: "BODY",
            skillNames: ["demo"],
          },
        },
      },
    },
  };
  const malformed: ModelMessage = {
    role: "user",
    content: "/demo execute",
    providerOptions: {
      rollHarness: {
        explicitSkillCheckpoint: {
          version: 1,
          kind: "explicit-skill",
          snapshot: { userPrompt: "execute" },
        },
      },
    },
  };

  assert.equal(readExplicitSkillCheckpoint(unknownVersion), undefined);
  assert.equal(readExplicitSkillCheckpoint(malformed), undefined);
  assert.equal(
    isExplicitSkillCheckpointV1(
      unknownVersion.providerOptions?.rollHarness?.explicitSkillCheckpoint,
    ),
    false,
  );
  assert.equal(
    isExplicitSkillCheckpointV1(malformed.providerOptions?.rollHarness?.explicitSkillCheckpoint),
    false,
  );
});

test("sanitizePersistedExplicitSkillCheckpoint fail-closed 清除异常 checkpoint 中的旧正文", () => {
  const cases: readonly ModelMessage[] = [
    {
      role: "user",
      content: "/demo unknown",
      providerOptions: {
        openai: { reasoningEffort: "high" },
        rollHarness: {
          traceId: "unknown-trace",
          explicitSkillCheckpoint: {
            version: 2,
            kind: "explicit-skill",
            snapshot: {
              userPrompt: "unknown",
              modelUserContent: "UNKNOWN_VERSION_BODY",
              skillNames: ["demo"],
            },
          },
        },
      },
    },
    {
      role: "user",
      content: "/demo malformed",
      providerOptions: {
        anthropic: { effort: "high" },
        rollHarness: {
          traceId: "malformed-trace",
          explicitSkillCheckpoint: {
            version: 1,
            kind: "explicit-skill",
            snapshot: {
              userPrompt: "malformed",
              modelUserContent: "MALFORMED_BODY",
            },
          },
        },
      },
    },
  ];

  const sanitized = cases.map(sanitizePersistedExplicitSkillCheckpoint);

  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /UNKNOWN_VERSION_BODY|MALFORMED_BODY|modelUserContent/u,
  );
  assert.equal(sanitized[0]?.providerOptions?.rollHarness?.traceId, "unknown-trace");
  assert.deepEqual(sanitized[0]?.providerOptions?.openai, { reasoningEffort: "high" });
  assert.equal(sanitized[1]?.providerOptions?.rollHarness?.traceId, "malformed-trace");
  assert.deepEqual(sanitized[1]?.providerOptions?.anthropic, { effort: "high" });
  assert.match(JSON.stringify(cases), /UNKNOWN_VERSION_BODY|MALFORMED_BODY/u);
});

test("applyExplicitSkillContext 替换文本时保留用户消息的附件 parts", () => {
  const snapshot = checkpointSnapshot("demo", "看下这张截图", "SKILL_BODY\n\n看下这张截图");
  const messages: ModelMessage[] = [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "done" },
    {
      role: "user",
      content: [
        { type: "text", text: "/demo 看下这张截图" },
        { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
      ],
    },
  ];

  const materialized = applyExplicitSkillContext(messages, snapshot);

  assert.deepEqual(materialized[2], {
    role: "user",
    content: [
      { type: "text", text: "SKILL_BODY\n\n看下这张截图" },
      { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
    ],
  });
  assert.equal(materialized[0]?.content, "earlier");
  assert.doesNotThrow(() => modelMessageSchema.parse(materialized[2]));
});

test("prepareExplicitSkillContext 对路径开头的输入原样透传", () => {
  const snapshot = prepareExplicitSkillContext({
    rawInput: "/Users/gt/yc/supplier2.0/AGENTS.md 依据规则审核",
    skillSummaries: [],
    skillLibrary: undefined,
  });
  assert.equal(snapshot.userPrompt, "/Users/gt/yc/supplier2.0/AGENTS.md 依据规则审核");
  assert.equal(snapshot.modelUserContent, "/Users/gt/yc/supplier2.0/AGENTS.md 依据规则审核");
  assert.deepEqual(snapshot.skillNames, []);
});
