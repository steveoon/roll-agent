import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveConversationSignals,
  resolveExpectedSignals,
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
});
