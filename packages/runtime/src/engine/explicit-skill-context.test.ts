import { test } from "node:test";
import assert from "node:assert/strict";
import { modelMessageSchema, type ModelMessage } from "ai";
import type { SkillLibrary, SkillSummary } from "@roll-agent/core/skills/library";
import {
  attachExplicitSkillCheckpoint,
  isExplicitSkillCheckpointV1,
  materializeExplicitSkillCheckpoints,
  prepareExplicitSkillContext,
  readExplicitSkillCheckpoint,
  stripExplicitSkillCheckpoints,
  type ExplicitSkillContextSnapshot,
} from "./explicit-skill-context.ts";

function checkpointSnapshot(
  name: string,
  userPrompt: string,
  modelUserContent: string,
): ExplicitSkillContextSnapshot {
  return { userPrompt, modelUserContent, skillNames: [name] };
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

test("explicit Skill checkpoint 经 ModelMessage JSON roundtrip 后仍可读取且保留原始输入", () => {
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
  assert.deepEqual(checkpoint.snapshot, snapshot);
  assert.deepEqual(roundtripped.providerOptions?.openai, { reasoningEffort: "high" });
  assert.equal(
    roundtripped.providerOptions?.rollHarness?.traceId,
    "trace-1",
    "attach 应保留同 namespace 下的其他 Harness metadata",
  );
});

test("materializeExplicitSkillCheckpoints 还原所有历史 checkpoint 并剥离隐藏 metadata", () => {
  const first = attachExplicitSkillCheckpoint(
    {
      role: "user",
      content: "/one first",
      providerOptions: { openai: { cache: true } },
    },
    checkpointSnapshot("one", "first", "ONE_BODY\n\nfirst"),
  );
  const second = attachExplicitSkillCheckpoint(
    { role: "user", content: "/two second" },
    checkpointSnapshot("two", "second", "TWO_BODY\n\nsecond"),
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

  const materialized = materializeExplicitSkillCheckpoints([
    first,
    { role: "assistant", content: "first done" },
    second,
    future,
    assistantWithHiddenMetadata,
  ]);

  assert.equal(materialized[0]?.content, "ONE_BODY\n\nfirst");
  assert.equal(materialized[2]?.content, "TWO_BODY\n\nsecond");
  assert.equal(materialized[3]?.content, "/future request", "未知版本必须安全忽略");
  assert.equal(first.content, "/one first", "materialize 不得改写持久化原消息");
  assert.equal(second.content, "/two second");
  assert.deepEqual(materialized[0]?.providerOptions, { openai: { cache: true } });
  assert.deepEqual(materialized[3]?.providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
  assert.deepEqual(materialized[4]?.providerOptions, { openai: { itemId: "item-1" } });
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
          snapshot: { userPrompt: "execute", skillNames: ["demo"] },
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
