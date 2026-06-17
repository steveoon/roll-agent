import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinRecommendFilterRequest } from "../pages/zhipin/recommend-filter.ts";
import {
  setZhipinFilterRecommendCandidatesDepsForTests,
  zhipinFilterRecommendCandidates,
} from "./zhipin-filter-recommend-candidates.ts";

function createTestContext(): AgentContext {
  return {
    llm: {
      generateText: async () => "",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

afterEach(() => {
  setZhipinFilterRecommendCandidatesDepsForTests(undefined);
});

describe("zhipin_filter_recommend_candidates", () => {
  it("keeps parsed fields undefined so the executor can distinguish standard patch requests", () => {
    const parsed = zhipinFilterRecommendCandidates.input.parse({});

    assert.equal(parsed.gender, undefined);
    assert.equal(parsed.activity, undefined);
    assert.equal(parsed.applyMode, undefined);
  });

  it("rejects an inverted age range", () => {
    assert.throws(
      () => zhipinFilterRecommendCandidates.input.parse({ ageMin: 40, ageMax: 20 }),
      /ageMax must be greater than or equal to ageMin/,
    );
  });

  it("requires a city when a district location filter is supplied", () => {
    assert.throws(
      () => zhipinFilterRecommendCandidates.input.parse({ locationDistrict: "浦东新区" }),
      /locationCity is required when locationDistrict is provided/,
    );
  });

  it("preserves the legacy empty-input reset request through the native page port", async () => {
    const calls: string[] = [];
    const nativePage = {
      async bringToFront() {
        calls.push("front");
      },
      async waitForRecommendList(timeoutMs?: number) {
        calls.push(`wait-list:${timeoutMs}`);
        return true;
      },
      async applyRecommendFilter(
        requested: ZhipinRecommendFilterRequest,
        options?: {
          readonly preClickDelayMs?: number;
          readonly pressDurationMs?: number;
          readonly settleMs?: number;
        },
      ) {
        calls.push(
          `apply:${requested.applyMode}:${requested.optionSelections
            .map((selection) => `${selection.fieldKey}=${selection.values.join("|")}`)
            .join(",")}`,
        );
        calls.push(
          `timing:${options?.preClickDelayMs}:${options?.pressDurationMs}:${options?.settleMs}`,
        );
        assert.deepEqual(requested, {
          applyMode: "patch",
          ageMin: 16,
          optionSelections: [
            {
              fieldKey: "gender",
              label: "性别",
              values: ["不限"],
              selection: "single",
              clearValue: "不限",
            },
            {
              fieldKey: "activity",
              label: "活跃度",
              values: ["不限"],
              selection: "single",
              clearValue: "不限",
            },
          ],
        });
        return {
          status: "applied" as const,
          requested,
          applied: {
            ageMin: 16,
            optionSelections: [
              { fieldKey: "gender" as const, label: "性别", values: ["不限"] },
              { fieldKey: "activity" as const, label: "活跃度", values: ["不限"] },
            ],
            gender: "不限",
            activity: "不限",
          },
          filterButtonText: "筛选·3",
        };
      },
      close() {
        calls.push("close");
      },
    } as unknown as ZhipinNativePagePort;

    setZhipinFilterRecommendCandidatesDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`begin:${label}`);
          return true;
        },
        async highlightSelector(selector: string) {
          calls.push(`highlight:${selector}`);
          return true;
        },
        async previewMouseMotion() {},
        async succeed(label: string) {
          calls.push(`succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          calls.push(`fail:${label}`);
          return true;
        },
      }),
    });

    const result = await zhipinFilterRecommendCandidates.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.status, "applied");
    assert.equal(result.filterButtonText, "筛选·3");
    assert.equal(result.applied?.gender, "不限");
    assert.deepEqual(calls, [
      "begin:正在打开推荐筛选",
      "wait-list:3000",
      "begin:正在设置推荐筛选",
      "highlight:.recommend-filter .filter-label, .filter-label-wrap .filter-label, .filter-label",
      "apply:patch:gender=不限,activity=不限",
      "timing:350:130:600",
      "succeed:已应用推荐筛选",
      "close",
    ]);
  });

  it("does not apply legacy defaults when standard filter fields are supplied", async () => {
    const nativePage = {
      async bringToFront() {},
      async waitForRecommendList() {
        return true;
      },
      async applyRecommendFilter(requested: ZhipinRecommendFilterRequest) {
        assert.equal(requested.applyMode, "patch");
        assert.equal(requested.ageMin, undefined);
        assert.equal(requested.ageMax, undefined);
        assert.deepEqual(
          requested.optionSelections.map((selection) => [
            selection.fieldKey,
            selection.label,
            selection.values,
          ]),
          [["degree", "学历要求", ["本科"]]],
        );
        return {
          status: "applied" as const,
          requested,
          applied: {
            optionSelections: requested.optionSelections.map((selection) => ({
              fieldKey: selection.fieldKey,
              label: selection.label,
              values: selection.values,
            })),
          },
        };
      },
      close() {},
    } as unknown as ZhipinNativePagePort;

    setZhipinFilterRecommendCandidatesDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
        async begin() {
          return true;
        },
        async highlightSelector() {
          return true;
        },
        async previewMouseMotion() {},
        async succeed() {
          return true;
        },
        async fail() {
          return true;
        },
      }),
    });

    const result = await zhipinFilterRecommendCandidates.execute(
      {
        degree: ["本科"],
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.requested.ageMin, undefined);
    assert.deepEqual(
      result.requested.optionSelections.map((selection) => selection.fieldKey),
      ["degree"],
    );
  });

  it("maps city and district filters to the native location request", async () => {
    const nativePage = {
      async bringToFront() {},
      async waitForRecommendList() {
        return true;
      },
      async applyRecommendFilter(requested: ZhipinRecommendFilterRequest) {
        assert.equal(requested.applyMode, "patch");
        assert.equal(requested.ageMin, undefined);
        assert.equal(requested.ageMax, undefined);
        assert.deepEqual(requested.location, {
          city: "上海市",
          district: "浦东新区",
        });
        assert.deepEqual(requested.optionSelections, []);
        return {
          status: "applied" as const,
          requested,
          applied: {
            location: requested.location,
            optionSelections: [],
          },
        };
      },
      close() {},
    } as unknown as ZhipinNativePagePort;

    setZhipinFilterRecommendCandidatesDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
        async begin() {
          return true;
        },
        async highlightSelector() {
          return true;
        },
        async previewMouseMotion() {},
        async succeed() {
          return true;
        },
        async fail() {
          return true;
        },
      }),
    });

    const result = await zhipinFilterRecommendCandidates.execute(
      {
        locationCity: "上海市",
        locationDistrict: "浦东新区",
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.requested.location, {
      city: "上海市",
      district: "浦东新区",
    });
    assert.deepEqual(result.applied?.location, {
      city: "上海市",
      district: "浦东新区",
    });
  });

  it("maps all modeled filter fields to standard native option selections", async () => {
    const nativePage = {
      async bringToFront() {},
      async waitForRecommendList() {
        return true;
      },
      async applyRecommendFilter(requested: ZhipinRecommendFilterRequest) {
        assert.equal(requested.applyMode, "replace");
        assert.equal(requested.ageMin, 22);
        assert.equal(requested.ageMax, 35);
        assert.deepEqual(
          requested.optionSelections.map((selection) => [
            selection.fieldKey,
            selection.label,
            selection.values,
            selection.selection,
          ]),
          [
            ["gender", "性别", ["女"], "single"],
            ["activity", "活跃度", ["今日活跃"], "single"],
            ["major", "专业", ["餐饮类", "酒店管理类"], "multi"],
            ["recentNotView", "近期没有看过", ["近14天没有"], "single"],
            ["exchangeResumeWithColleague", "是否与同事交换简历", ["近一个月没有"], "single"],
            ["candidateKeywords", "牛人关键词", ["健康证", "普通话"], "multi"],
            ["school", "院校", ["985", "211"], "multi"],
            ["switchJobFrequency", "跳槽频率", ["5年少于3份"], "single"],
            ["intention", "求职意向", ["离职-随时到岗", "在职-考虑机会"], "multi"],
            ["salary", "薪资待遇", ["5-10K"], "single"],
            ["degree", "学历要求", ["大专", "本科"], "multi"],
            ["experience", "经验要求", ["1-3年", "3-5年"], "multi"],
            ["callPhone", "是否可拨打电话", ["可拨打"], "single"],
          ],
        );
        return {
          status: "applied" as const,
          requested,
          applied: {
            ageMin: 22,
            ageMax: 35,
            optionSelections: requested.optionSelections.map((selection) => ({
              fieldKey: selection.fieldKey,
              label: selection.label,
              values: selection.values,
            })),
            gender: "女",
            activity: "今日活跃",
          },
        };
      },
      close() {},
    } as unknown as ZhipinNativePagePort;

    setZhipinFilterRecommendCandidatesDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
        async begin() {
          return true;
        },
        async highlightSelector() {
          return true;
        },
        async previewMouseMotion() {},
        async succeed() {
          return true;
        },
        async fail() {
          return true;
        },
      }),
    });

    const result = await zhipinFilterRecommendCandidates.execute(
      {
        applyMode: "replace",
        ageMin: 22,
        ageMax: 35,
        gender: "女",
        activity: "今日活跃",
        major: ["餐饮类", "酒店管理类"],
        recentNotView: "近14天没有",
        exchangeResumeWithColleague: "近一个月没有",
        candidateKeywords: ["健康证", "普通话"],
        school: ["985", "211"],
        switchJobFrequency: "5年少于3份",
        intention: ["离职-随时到岗", "在职-考虑机会"],
        salary: "5-10K",
        degree: ["大专", "本科"],
        experience: ["1-3年", "3-5年"],
        callPhone: "可拨打",
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.requested.applyMode, "replace");
    assert.equal(result.requested.optionSelections.length, 13);
    assert.deepEqual(
      result.applied?.optionSelections.find((selection) => selection.fieldKey === "degree")?.values,
      ["大专", "本科"],
    );
  });

  it("returns structured failure when the native helper reports a VIP gate", async () => {
    const nativePage = {
      async bringToFront() {},
      async waitForRecommendList() {
        return true;
      },
      async applyRecommendFilter(requested: ZhipinRecommendFilterRequest) {
        return {
          status: "requires_vip" as const,
          requested,
          error: "筛选条件触发 VIP 弹窗",
        };
      },
      close() {},
    } as unknown as ZhipinNativePagePort;

    setZhipinFilterRecommendCandidatesDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
        async begin() {
          return true;
        },
        async highlightSelector() {
          return true;
        },
        async previewMouseMotion() {},
        async succeed() {
          return true;
        },
        async fail() {
          return true;
        },
      }),
    });

    const result = await zhipinFilterRecommendCandidates.execute(
      {
        ageMin: 20,
        ageMax: 40,
        gender: "男",
        activity: "刚刚活跃",
      },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.status, "requires_vip");
    assert.equal(result.error, "筛选条件触发 VIP 弹窗");
  });
});
