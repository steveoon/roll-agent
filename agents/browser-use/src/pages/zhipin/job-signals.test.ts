import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveConversationSignals,
  resolveExpectedSignals,
  resolveLocationSignalsFromLlmText,
  resolveLocationSignalsWithLlm,
  resolvePreferredBrand,
  shouldAnalyzeLocationSignals,
} from "./job-signals.ts";

interface CandidateFixtureInput {
  candidateMessage: string;
  conversationHistory: string[];
  candidateInfo: {
    name: string;
    age: string;
    experience: string;
    communicationPosition: string;
  };
  target: {
    platform: "zhipin";
    conversationId: string;
    candidateId: string;
    recruiterUsername: string;
  };
}

const FIXTURE_A_TOOL_INPUT = {
  candidateMessage: "兼职怎么算的？两个人需要吗？",
  conversationHistory: [
    "我: 你好，我们正在诚招餐饮兼职服务员，想跟你沟通一下",
    "求职者: 兼职怎么算的？",
    "求职者: 两个人需要吗？",
  ],
  candidateInfo: {
    name: "阳志园",
    age: "24岁",
    experience: "6年",
    communicationPosition: "餐饮兼职服务员",
  },
  target: {
    platform: "zhipin",
    conversationId: "708401971-0",
    candidateId: "708401971-0",
    recruiterUsername: "任思文",
  },
} satisfies CandidateFixtureInput;

function buildToolInputWithSignals(input: CandidateFixtureInput, expectedJobText: string) {
  const signals = resolveConversationSignals({
    communicationPosition: input.candidateInfo.communicationPosition,
    expectedJobText,
  });

  return {
    ...input,
    candidateInfo: {
      ...input.candidateInfo,
      communicationPosition: signals.communicationPosition,
      expectedLocation: signals.expectedLocation,
      expectedPosition: signals.expectedPosition,
    },
    ...(signals.preferredBrand !== undefined ? { preferredBrand: signals.preferredBrand } : {}),
  };
}

describe("job-signals", () => {
  it("parses expected signals from the recent-focus text", () => {
    const result = resolveConversationSignals({
      communicationPosition: "餐饮兼职服务员",
      expectedJobText: "上海 · 服务员",
    });

    assert.deepEqual(result, {
      communicationPosition: "餐饮兼职服务员",
      expectedLocation: "上海",
      expectedPosition: "服务员",
    });
  });

  it("returns empty expected signals when recent-focus text is absent", () => {
    assert.deepEqual(resolveExpectedSignals(""), {
      expectedLocation: "",
      expectedPosition: "",
    });
  });

  it("extracts preferredBrand from hyphenated job titles only", () => {
    assert.equal(resolvePreferredBrand("肯德基-服务员"), "肯德基");
    assert.equal(resolvePreferredBrand("你六姐-咖啡师"), "你六姐");
    assert.equal(resolvePreferredBrand("餐饮兼职服务员"), undefined);
  });

  it('assembles Fixture A ("阳志园") into a no-brand generate_reply input', () => {
    const toolInput = buildToolInputWithSignals(FIXTURE_A_TOOL_INPUT, "上海 · 服务员");

    assert.deepEqual(toolInput, {
      ...FIXTURE_A_TOOL_INPUT,
      candidateInfo: {
        ...FIXTURE_A_TOOL_INPUT.candidateInfo,
        communicationPosition: "餐饮兼职服务员",
        expectedLocation: "上海",
        expectedPosition: "服务员",
      },
    });
    assert.equal("preferredBrand" in toolInput, false);
  });

  it('assembles Fixture B ("肯德基-服务员") into a branded generate_reply input', () => {
    const toolInput = buildToolInputWithSignals(
      {
        ...FIXTURE_A_TOOL_INPUT,
        candidateInfo: {
          ...FIXTURE_A_TOOL_INPUT.candidateInfo,
          communicationPosition: "肯德基-服务员",
        },
      },
      "北京 · 服务员",
    );

    assert.deepEqual(toolInput, {
      ...FIXTURE_A_TOOL_INPUT,
      candidateInfo: {
        ...FIXTURE_A_TOOL_INPUT.candidateInfo,
        communicationPosition: "肯德基-服务员",
        expectedLocation: "北京",
        expectedPosition: "服务员",
      },
      preferredBrand: "肯德基",
    });
  });

  it("extracts, validates, de-duplicates and ranks LLM location signals", () => {
    const result = resolveLocationSignalsFromLlmText({
      latestCandidateMessage: "那徐家汇附近有吗",
      recentMessages: [
        { index: 1, sender: "candidate", content: "我想找离家近一点的" },
        { index: 2, sender: "recruiter", content: "人民广场也有门店" },
        { index: 3, sender: "candidate", content: "那徐家汇附近有吗" },
      ],
      expectedLocation: "上海",
      communicationPosition: "肯德基-服务员",
      llmText:
        "```json\n" +
        JSON.stringify({
          locationSignals: [
            {
              text: "上海",
              source: "candidate_expected_location",
              intent: "nearby_store",
              confidence: 0.99,
            },
            {
              text: "不存在商场",
              source: "candidate_message",
              intent: "nearby_store",
              confidence: 0.95,
            },
            {
              text: "徐家汇",
              source: "candidate_message",
              city: "上海",
              intent: "nearby_store",
              confidence: 0.92,
            },
          ],
        }) +
        "\n```",
    });

    assert.deepEqual(result, [
      {
        text: "徐家汇",
        source: "candidate_message",
        city: "上海",
        intent: "nearby_store",
        confidence: 0.92,
      },
      {
        text: "上海",
        source: "candidate_expected_location",
        city: "上海",
        intent: "expected_area",
        confidence: 0.6,
      },
    ]);
  });

  it("accepts conversation-history evidence when the latest message is contextual", () => {
    const result = resolveLocationSignalsFromLlmText({
      latestCandidateMessage: "那边过去远吗",
      recentMessages: [
        { index: 1, sender: "recruiter", content: "人民广场门店还在招服务员" },
        { index: 2, sender: "candidate", content: "那边过去远吗" },
      ],
      expectedLocation: "",
      communicationPosition: "肯德基-服务员",
      llmText: JSON.stringify([
        {
          text: "人民广场",
          source: "conversation_history",
          city: "上海",
          intent: "nearby_store",
          confidence: 0.78,
        },
      ]),
    });

    assert.deepEqual(result, [
      {
        text: "人民广场",
        source: "conversation_history",
        intent: "nearby_store",
        confidence: 0.78,
      },
    ]);
  });

  it("extracts explicit metro station and subway line signals", () => {
    const metroStation = resolveLocationSignalsFromLlmText({
      latestCandidateMessage: "某某地铁站附近有吗",
      recentMessages: [{ index: 1, sender: "candidate", content: "某某地铁站附近有吗" }],
      expectedLocation: "",
      communicationPosition: "肯德基-服务员",
      llmText: JSON.stringify([
        {
          text: "某某地铁站",
          source: "candidate_message",
          intent: "nearby_store",
          confidence: 0.9,
        },
      ]),
    });
    const subwayLine = resolveLocationSignalsFromLlmText({
      latestCandidateMessage: "我在2号线附近，别太远",
      recentMessages: [{ index: 1, sender: "candidate", content: "我在2号线附近，别太远" }],
      expectedLocation: "",
      communicationPosition: "肯德基-服务员",
      llmText: JSON.stringify([
        {
          text: "2号线",
          source: "candidate_message",
          intent: "nearby_store",
          confidence: 0.86,
        },
      ]),
    });

    assert.deepEqual(metroStation, [
      {
        text: "某某地铁站",
        source: "candidate_message",
        intent: "nearby_store",
        confidence: 0.9,
      },
    ]);
    assert.deepEqual(subwayLine, [
      {
        text: "2号线",
        source: "candidate_message",
        intent: "nearby_store",
        confidence: 0.86,
      },
    ]);
  });

  it("falls back to weak expectedLocation signals when LLM extraction fails", async () => {
    let warning = "";
    const result = await resolveLocationSignalsWithLlm({
      llm: {
        generateText: async () => "not json",
      },
      logger: {
        warn: (message) => {
          warning = message;
        },
      },
      messages: [{ index: 1, sender: "candidate", content: "就近安排吗" }],
      expectedLocation: "上海",
      communicationPosition: "",
    });

    assert.deepEqual(result, [
      {
        text: "上海",
        source: "candidate_expected_location",
        city: "上海",
        intent: "expected_area",
        confidence: 0.6,
      },
    ]);
    assert.match(warning, /Location signal extraction failed/);
  });

  it("skips LLM extraction for greeting-only candidate messages", async () => {
    let llmCalled = false;
    const messages = [
      {
        index: 1,
        sender: "candidate" as const,
        content:
          "您好，我是北京劳动保障职业学院大专生，可以和您进一步沟通北京Pizza-日结服务员-就近安排职位吗？",
      },
    ];

    assert.equal(
      shouldAnalyzeLocationSignals({
        messages,
        expectedLocation: "北京",
        communicationPosition: "北京Pizza-日结服务员-就近安排",
      }),
      false,
    );
    const result = await resolveLocationSignalsWithLlm({
      llm: {
        generateText: async () => {
          llmCalled = true;
          throw new Error("should not call LLM for greetings");
        },
      },
      messages,
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
      timeoutMs: 5,
    });

    assert.equal(llmCalled, false);
    assert.deepEqual(result, [
      {
        text: "北京",
        source: "candidate_expected_location",
        city: "北京",
        intent: "expected_area",
        confidence: 0.6,
      },
    ]);
  });

  it("keeps candidate city questions eligible even when they match expectedLocation", () => {
    assert.equal(
      shouldAnalyzeLocationSignals({
        messages: [{ index: 1, sender: "candidate", content: "北京有吗" }],
        expectedLocation: "北京",
        communicationPosition: "北京Pizza-日结服务员-就近安排",
      }),
      true,
    );
  });

  it("keeps candidate_message evidence from earlier candidate turns when latest is non-location", () => {
    const result = resolveLocationSignalsFromLlmText({
      latestCandidateMessage: "好的",
      recentMessages: [
        { index: 1, sender: "candidate", content: "怀柔还招人吗" },
        { index: 2, sender: "recruiter", content: "在的" },
        { index: 3, sender: "candidate", content: "好的" },
      ],
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
      llmText: JSON.stringify([
        {
          text: "怀柔",
          source: "candidate_message",
          intent: "expected_area",
          confidence: 0.9,
        },
      ]),
    });

    assert.deepEqual(result, [
      {
        text: "怀柔",
        source: "candidate_message",
        intent: "expected_area",
        confidence: 0.9,
      },
      {
        text: "北京",
        source: "candidate_expected_location",
        city: "北京",
        intent: "expected_area",
        confidence: 0.6,
      },
    ]);
  });

  it("extracts rule-based location signals from earlier candidate turns on timeout fallback", async () => {
    const result = await resolveLocationSignalsWithLlm({
      llm: {
        generateText: async () => await new Promise<string>(() => {}),
      },
      messages: [
        { index: 1, sender: "candidate", content: "是在阳坊吗" },
        { index: 2, sender: "candidate", content: "管吃管住吗" },
      ],
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
      timeoutMs: 5,
    });

    assert.deepEqual(result, [
      {
        text: "阳坊",
        source: "candidate_message",
        city: "北京",
        intent: "expected_area",
        confidence: 0.74,
      },
      {
        text: "北京",
        source: "candidate_expected_location",
        city: "北京",
        intent: "expected_area",
        confidence: 0.6,
      },
    ]);
  });

  it("falls back to bounded rule-based signals when LLM extraction times out", async () => {
    let warning = "";
    const startedAt = Date.now();
    const messages = [{ index: 1, sender: "candidate" as const, content: "是在阳坊吗" }];

    assert.equal(
      shouldAnalyzeLocationSignals({
        messages,
        expectedLocation: "北京",
        communicationPosition: "北京Pizza-日结服务员-就近安排",
      }),
      true,
    );
    const result = await resolveLocationSignalsWithLlm({
      llm: {
        generateText: async () => await new Promise<string>(() => {}),
      },
      logger: {
        warn: (message) => {
          warning = message;
        },
      },
      messages,
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
      timeoutMs: 5,
    });

    assert.ok(Date.now() - startedAt < 1_000);
    assert.deepEqual(result, [
      {
        text: "阳坊",
        source: "candidate_message",
        city: "北京",
        intent: "expected_area",
        confidence: 0.74,
      },
      {
        text: "北京",
        source: "candidate_expected_location",
        city: "北京",
        intent: "expected_area",
        confidence: 0.6,
      },
    ]);
    assert.match(warning, /timed out/);
  });
});
