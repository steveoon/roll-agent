import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContextInfoByNeeds } from "./context-builder.ts";
import { DEFAULT_REPLY_POLICY } from "../types/reply-policy.ts";
import type { TurnPlan } from "../types/reply-policy.ts";
import type { ZhipinData } from "../types/zhipin.ts";

const sampleData: ZhipinData = {
  meta: { defaultBrandId: "brand-1", source: "test" },
  brands: [
    {
      id: "brand-1",
      name: "必胜客",
      stores: [
        {
          id: "store-1",
          brandId: "brand-1",
          name: "佛山南海万达店",
          city: "佛山",
          location: "南海区桂澜路万达广场1层",
          district: "南海区",
          subarea: "桂城",
          coordinates: { lng: 113.143, lat: 23.028 },
          positions: [
            {
              id: "pos-1",
              name: "餐厅服务员",
              sourceJobName: "必胜客-万达广场-餐厅服务员-兼职",
              jobCategory: "普通服务员",
              brandId: "brand-1",
              brandName: "必胜客",
              description: "负责门店服务",
              laborForm: "兼职",
              employmentForm: "长期用工",
              trainingRequired: "不需要",
              probationRequired: "不需要",
              timeSlots: ["09:00~14:00", "18:00~22:00"],
              salary: {
                base: 22,
                unit: "元/小时",
                memo: "时薪",
              },
              workHours: "4",
              benefits: {
                insurance: null,
                accommodation: null,
                catering: null,
                moreWelfares: null,
                memo: null,
                promotion: null,
              },
              availableSlots: [
                {
                  slot: "周末晚班",
                  maxCapacity: 5,
                  currentBooked: 1,
                  isAvailable: true,
                  priority: "high",
                },
              ],
              minHoursPerWeek: null,
              maxHoursPerWeek: null,
              perMonthMinWorkTime: 80,
              attendanceRequirement: {
                minimumDays: 3,
                description: "每周至少 3 天",
              },
              hiringRequirements: {
                minAge: 18,
                maxAge: 45,
                education: "高中",
              },
            },
          ],
        },
      ],
    },
  ],
};

function makePlan(overrides?: Partial<TurnPlan>): TurnPlan {
  return {
    stage: "job_consultation",
    subGoals: ["回答核心问题"],
    needs: ["salary", "schedule"],
    primaryNeed: "salary",
    riskFlags: [],
    confidence: 0.8,
    extractedInfo: {
      mentionedBrand: "必胜客",
      city: "佛山",
      mentionedLocations: null,
      mentionedDistricts: null,
      specificAge: null,
      hasUrgency: null,
      preferredSchedule: null,
    },
    reasoningText: "test",
    ...overrides,
  };
}

describe("buildContextInfoByNeeds", () => {
  it("uses generic context in minimal mode", async () => {
    const result = await buildContextInfoByNeeds(
      sampleData,
      makePlan(),
      undefined,
      "必胜客",
      undefined,
      undefined,
      DEFAULT_REPLY_POLICY,
      undefined,
      1,
      "minimal",
    );

    assert.equal(result.debugInfo.detailLevel, "minimal");
    assert.equal(result.debugInfo.storeCount, 0);
    assert.ok(!result.contextInfo.includes("薪资："));
    assert.ok(!result.contextInfo.includes("职位："));
  });

  it("injects only the primary need fact family in focused mode", async () => {
    const result = await buildContextInfoByNeeds(
      sampleData,
      makePlan(),
      undefined,
      "必胜客",
      undefined,
      undefined,
      DEFAULT_REPLY_POLICY,
      undefined,
      2,
      "focused",
    );

    assert.equal(result.debugInfo.detailLevel, "focused");
    assert.equal(result.debugInfo.primaryNeed, "salary");
    assert.ok(result.contextInfo.includes("薪资："));
    assert.ok(!result.contextInfo.includes("万达广场1层"));
    assert.ok(!result.contextInfo.includes("排班："));
    assert.ok(!result.contextInfo.includes("时间："));
  });

  it("allows an explicit secondary need in focused mode", async () => {
    const result = await buildContextInfoByNeeds(
      sampleData,
      makePlan({ needs: ["salary", "location"] }),
      undefined,
      "必胜客",
      undefined,
      undefined,
      DEFAULT_REPLY_POLICY,
      undefined,
      2,
      "focused",
      ["salary", "location"],
    );

    assert.ok(result.contextInfo.includes("薪资："));
    assert.ok(result.contextInfo.includes("万达广场1层"));
  });

  it("omits salary line when base and memo are both missing", async () => {
    const data = structuredClone(sampleData);
    data.brands[0]!.stores[0]!.positions[0]!.salary = {
      base: null,
      unit: null,
      memo: "",
    };

    const result = await buildContextInfoByNeeds(
      data,
      makePlan(),
      undefined,
      "必胜客",
      undefined,
      undefined,
      DEFAULT_REPLY_POLICY,
      undefined,
      2,
      "focused",
    );

    assert.ok(!result.contextInfo.includes("薪资："));
  });

  it("renders monthly minimum work time without hardcoded hour unit", async () => {
    const result = await buildContextInfoByNeeds(
      sampleData,
      makePlan({ needs: ["schedule"], primaryNeed: "schedule" }),
      undefined,
      "必胜客",
      undefined,
      undefined,
      DEFAULT_REPLY_POLICY,
      undefined,
      2,
      "focused",
    );

    assert.ok(result.contextInfo.includes("月最低工时：80"));
    assert.ok(!result.contextInfo.includes("月最低工时：80小时"));
  });

  it("formats store location without null placeholders", async () => {
    const data = structuredClone(sampleData);
    data.brands[0]!.stores[0]!.district = null;
    data.brands[0]!.stores[0]!.subarea = null;

    const result = await buildContextInfoByNeeds(
      data,
      makePlan({ needs: ["location"], primaryNeed: "location" }),
      undefined,
      "必胜客",
      undefined,
      undefined,
      DEFAULT_REPLY_POLICY,
      undefined,
      2,
      "focused",
      ["location"],
    );

    assert.ok(result.contextInfo.includes("• 佛山南海万达店：南海区桂澜路万达广场1层"));
    assert.ok(!result.contextInfo.includes("null"));
  });
});
