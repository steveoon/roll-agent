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
              brandId: "brand-1",
              brandName: "必胜客",
              timeSlots: ["09:00~14:00", "18:00~22:00"],
              salary: {
                base: 22,
                memo: "时薪",
              },
              workHours: "4-8小时",
              benefits: { items: [] },
              requirements: ["有服务意识"],
              urgent: true,
              scheduleType: "flexible",
              attendancePolicy: {
                punctualityRequired: true,
                lateToleranceMinutes: 10,
                attendanceTracking: "strict",
                makeupShiftsAllowed: false,
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
              schedulingFlexibility: {
                canSwapShifts: false,
                advanceNoticeHours: 24,
                partTimeAllowed: true,
                weekendRequired: false,
                holidayRequired: false,
              },
              attendanceRequirement: {
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
});
