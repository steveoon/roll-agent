import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  clearLocationSignalResolutionCacheForTest,
  resolveConversationSignals,
  resolveExpectedSignals,
  formatLocationSignalsVisualLabel,
  resolveLocationSignals,
  resolveLocationSignalsFromLlmText,
  resolveLocationSignalsWithLlm,
  resolvePreferredBrand,
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

function buildLocationInquiryLlmText(locationSignals: readonly unknown[]): string {
  return JSON.stringify({
    inquiryType: "location_inquiry",
    reason: "候选人正在咨询地点",
    locationSignals,
  });
}

function buildNonLocationInquiryLlmText(reason = "候选人没有咨询地点"): string {
  return JSON.stringify({
    inquiryType: "non_location_inquiry",
    reason,
    locationSignals: [],
  });
}

describe("job-signals", () => {
  beforeEach(() => {
    clearLocationSignalResolutionCacheForTest();
  });

  it("formats location signal summaries by analysis path", () => {
    assert.equal(formatLocationSignalsVisualLabel([]), "未识别到地点线索");
    assert.equal(
      formatLocationSignalsVisualLabel({
        analysisPath: "llm",
        signals: [
          {
            text: "阳坊",
            source: "candidate_message",
            city: "北京",
            intent: "expected_area",
            confidence: 1,
          },
          {
            text: "北京",
            source: "candidate_expected_location",
            city: "北京",
            intent: "expected_area",
            confidence: 0.6,
          },
        ],
      }),
      "已识别地点：阳坊",
    );
    assert.equal(
      formatLocationSignalsVisualLabel({
        analysisPath: "llm",
        inquiryType: "non_location_inquiry",
        signals: [],
      }),
      "非地点咨询",
    );
    assert.equal(
      formatLocationSignalsVisualLabel({
        analysisPath: "llm",
        signals: [
          {
            text: "北京",
            source: "candidate_expected_location",
            city: "北京",
            intent: "expected_area",
            confidence: 0.6,
          },
        ],
      }),
      "未识别到地点线索",
    );
    assert.equal(
      formatLocationSignalsVisualLabel({
        analysisPath: "profile_only",
        signals: [
          {
            text: "北京",
            source: "candidate_expected_location",
            city: "北京",
            intent: "expected_area",
            confidence: 0.6,
          },
        ],
      }),
      "资料城市提示：北京（弱）",
    );
    assert.equal(
      formatLocationSignalsVisualLabel({
        analysisPath: "fallback",
        signals: [
          {
            text: "阳坊",
            source: "candidate_message",
            city: "北京",
            intent: "expected_area",
            confidence: 0.74,
          },
        ],
      }),
      "已识别地点（兜底）：阳坊",
    );
  });

  it("attempts LLM analysis for district and job-area inquiries such as Mentougou", async () => {
    const messages = [
      {
        index: 1,
        sender: "candidate" as const,
        content: "请问门头沟这个岗位还需要人吗",
      },
    ];
    const analysisInput = {
      messages,
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
    };

    let llmCalled = false;
    const resolution = await resolveLocationSignals({
      llm: {
        generateText: async () => {
          llmCalled = true;
          return buildLocationInquiryLlmText([
            {
              text: "门头沟",
              source: "candidate_message",
              city: "北京",
              intent: "expected_area",
              confidence: 0.91,
            },
          ]);
        },
      },
      ...analysisInput,
    });

    assert.equal(llmCalled, true);
    assert.equal(resolution.analysisPath, "llm");
    assert.deepEqual(resolution.signals, [
      {
        text: "门头沟",
        source: "candidate_message",
        city: "北京",
        intent: "expected_area",
        confidence: 0.91,
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

  it("calls LLM for operational non-location candidate messages", async () => {
    let llmCalled = false;
    const resolution = await resolveLocationSignals({
      llm: {
        generateText: async () => {
          llmCalled = true;
          return buildNonLocationInquiryLlmText("候选人在问兼职结算和人数，不是地点咨询");
        },
      },
      messages: [{ index: 1, sender: "candidate", content: "兼职怎么算的？两个人需要吗？" }],
      expectedLocation: "上海",
      communicationPosition: "餐饮兼职服务员",
    });

    assert.equal(llmCalled, true);
    assert.equal(resolution.analysisPath, "llm");
    assert.equal(resolution.inquiryType, "non_location_inquiry");
    assert.deepEqual(resolution.signals, []);
    assert.equal(formatLocationSignalsVisualLabel(resolution), "非地点咨询");
  });

  it("does not mix fallback signals into successful LLM analysis", async () => {
    const resolution = await resolveLocationSignals({
      llm: {
        generateText: async () => buildNonLocationInquiryLlmText("候选人在问是否还要兼职"),
      },
      messages: [
        {
          index: 1,
          sender: "candidate",
          content: "我想问一下这家店还要兼职吗",
        },
      ],
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
    });

    assert.equal(resolution.analysisPath, "llm");
    assert.equal(resolution.inquiryType, "non_location_inquiry");
    assert.deepEqual(resolution.signals, []);
  });

  it("honors explicit non-location LLM decisions for polite recruiting questions", async () => {
    const resolution = await resolveLocationSignals({
      llm: {
        generateText: async () =>
          buildNonLocationInquiryLlmText("候选人在问岗位是否还招，不是地点咨询"),
      },
      messages: [
        {
          index: 1,
          sender: "candidate",
          content: "请问，贵公司的日结周结服务员28一小时一天224元就近分配还在招人吗？",
        },
      ],
      expectedLocation: "上海",
      communicationPosition: "日结周结服务员28一小时一天224元就近分配",
    });

    assert.equal(resolution.analysisPath, "llm");
    assert.equal(resolution.inquiryType, "non_location_inquiry");
    assert.deepEqual(resolution.signals, []);
    assert.equal(formatLocationSignalsVisualLabel(resolution), "非地点咨询");
  });

  it("reuses successful LLM location signal resolution for identical evidence input", async () => {
    let llmCallCount = 0;
    const input = {
      llm: {
        generateText: async () => {
          llmCallCount += 1;
          return buildLocationInquiryLlmText([
            {
              text: "徐家汇",
              source: "candidate_message",
              city: "上海",
              intent: "nearby_store",
              confidence: 0.93,
            },
          ]);
        },
      },
      messages: [{ index: 1, sender: "candidate" as const, content: "徐家汇附近有吗" }],
      expectedLocation: "上海",
      communicationPosition: "肯德基-服务员",
    };

    const first = await resolveLocationSignals(input);
    const second = await resolveLocationSignals(input);

    assert.equal(llmCallCount, 1);
    assert.notEqual(first, second);
    assert.notEqual(first.signals[0], second.signals[0]);
    assert.deepEqual(second, first);
  });

  it("reuses in-flight LLM location signal resolution for concurrent identical input", async () => {
    let llmCallCount = 0;
    let resolveLlmText: ((value: string) => void) | undefined;
    const input = {
      llm: {
        generateText: async () => {
          llmCallCount += 1;
          return await new Promise<string>((resolve) => {
            resolveLlmText = resolve;
          });
        },
      },
      messages: [{ index: 1, sender: "candidate" as const, content: "徐家汇附近有吗" }],
      expectedLocation: "上海",
      communicationPosition: "肯德基-服务员",
    };

    const firstPromise = resolveLocationSignals(input);
    const secondPromise = resolveLocationSignals(input);

    assert.equal(llmCallCount, 1);
    if (resolveLlmText === undefined) {
      throw new Error("Expected LLM promise resolver to be registered");
    }
    resolveLlmText(
      buildLocationInquiryLlmText([
        {
          text: "徐家汇",
          source: "candidate_message",
          city: "上海",
          intent: "nearby_store",
          confidence: 0.93,
        },
      ]),
    );

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.notEqual(first, second);
    assert.notEqual(first.signals[0], second.signals[0]);
    assert.deepEqual(second, first);
  });

  it("misses the LLM location signal cache when candidate messages change", async () => {
    let llmCallCount = 0;
    const llm = {
      generateText: async () => {
        llmCallCount += 1;
        return buildNonLocationInquiryLlmText();
      },
    };

    await resolveLocationSignals({
      llm,
      messages: [{ index: 1, sender: "candidate", content: "徐家汇附近有吗" }],
      expectedLocation: "上海",
      communicationPosition: "肯德基-服务员",
    });
    await resolveLocationSignals({
      llm,
      messages: [{ index: 1, sender: "candidate", content: "人民广场附近有吗" }],
      expectedLocation: "上海",
      communicationPosition: "肯德基-服务员",
    });

    assert.equal(llmCallCount, 2);
  });

  it("expires cached LLM location signal resolution after the cache TTL", async () => {
    const originalDateNow = Date.now;
    let nowMs = 1_000;
    let llmCallCount = 0;
    const input = {
      llm: {
        generateText: async () => {
          llmCallCount += 1;
          return buildNonLocationInquiryLlmText();
        },
      },
      messages: [{ index: 1, sender: "candidate" as const, content: "徐家汇附近有吗" }],
      expectedLocation: "上海",
      communicationPosition: "肯德基-服务员",
    };

    Date.now = () => nowMs;
    try {
      await resolveLocationSignals(input);
      nowMs += 5 * 60_000 + 1;
      await resolveLocationSignals(input);
    } finally {
      Date.now = originalDateNow;
    }

    assert.equal(llmCallCount, 2);
  });

  it("does not cache failed LLM location signal fallback results", async () => {
    let llmCallCount = 0;
    const input = {
      llm: {
        generateText: async () => {
          llmCallCount += 1;
          return llmCallCount === 1
            ? "not json"
            : buildLocationInquiryLlmText([
                {
                  text: "徐家汇",
                  source: "candidate_message",
                  city: "上海",
                  intent: "nearby_store",
                  confidence: 0.93,
                },
              ]);
        },
      },
      messages: [{ index: 1, sender: "candidate" as const, content: "徐家汇附近有吗" }],
      expectedLocation: "上海",
      communicationPosition: "肯德基-服务员",
    };

    const first = await resolveLocationSignals(input);
    const second = await resolveLocationSignals(input);

    assert.equal(llmCallCount, 2);
    assert.equal(first.analysisPath, "fallback");
    assert.equal(second.analysisPath, "llm");
  });

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
          inquiryType: "location_inquiry",
          reason: "候选人在问徐家汇附近门店",
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
      llmText: buildLocationInquiryLlmText([
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
      llmText: buildLocationInquiryLlmText([
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
      llmText: buildLocationInquiryLlmText([
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

  it("calls LLM for greeting-only candidate messages", async () => {
    let llmCalled = false;
    const messages = [
      {
        index: 1,
        sender: "candidate" as const,
        content:
          "您好，我是北京劳动保障职业学院大专生，可以和您进一步沟通北京Pizza-日结服务员-就近安排职位吗？",
      },
    ];

    const result = await resolveLocationSignalsWithLlm({
      llm: {
        generateText: async () => {
          llmCalled = true;
          return buildNonLocationInquiryLlmText("候选人在打招呼并询问岗位沟通，不是地点咨询");
        },
      },
      messages,
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
    });

    assert.equal(llmCalled, true);
    assert.deepEqual(result, []);
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
      llmText: buildLocationInquiryLlmText([
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

  it("falls back to weak profile signals when LLM times out after earlier location turns", async () => {
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
        text: "北京",
        source: "candidate_expected_location",
        city: "北京",
        intent: "expected_area",
        confidence: 0.6,
      },
    ]);
  });

  it("keeps fallback limited to weak profile signals for generic or profile-only text", async () => {
    const genericStoreResult = await resolveLocationSignalsWithLlm({
      llm: {
        generateText: async () => await new Promise<string>(() => {}),
      },
      messages: [
        {
          index: 1,
          sender: "candidate",
          content: "我想问一下这家店还要兼职吗",
        },
      ],
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
      timeoutMs: 5,
    });
    const profileResult = await resolveLocationSignalsWithLlm({
      llm: {
        generateText: async () => await new Promise<string>(() => {}),
      },
      messages: [
        {
          index: 1,
          sender: "candidate",
          content: "BOSS您好，我有相关工作经验；2、我于北京房山区党校毕业，可否给您发送简历",
        },
      ],
      expectedLocation: "北京",
      communicationPosition: "北京Pizza-日结服务员-就近安排",
      timeoutMs: 5,
    });

    const weakSignal = {
      text: "北京",
      source: "candidate_expected_location" as const,
      city: "北京",
      intent: "expected_area" as const,
      confidence: 0.6,
    };
    assert.deepEqual(genericStoreResult, [weakSignal]);
    assert.deepEqual(profileResult, [weakSignal]);
  });

  it("times out quickly and falls back to weak profile signals", async () => {
    let warning = "";
    const startedAt = Date.now();
    const messages = [{ index: 1, sender: "candidate" as const, content: "是在阳坊吗" }];

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
