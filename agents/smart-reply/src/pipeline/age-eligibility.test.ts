import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectAgeEvidenceFromSources,
  createConfigDataAgeSource,
  createDefaultAgeEligibilitySources,
  evaluateAgeEligibility,
  type AgeEligibilitySource,
} from "./age-eligibility.ts";
import type { ZhipinData } from "../types/zhipin.ts";

const sampleData: ZhipinData = {
  meta: { defaultBrandId: "brand-1", source: "test" },
  brands: [
    {
      id: "brand-1",
      name: "必胜客",
      aliases: ["佛山必胜客"],
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
              salary: {
                base: 22,
                unit: "元/小时",
                memo: "时薪",
              },
              timeSlots: ["09:00~14:00"],
              workHours: "4",
              minHoursPerWeek: null,
              maxHoursPerWeek: null,
              perMonthMinWorkTime: 80,
              perMonthMinWorkTimeUnit: "小时",
              availableSlots: [],
              benefits: {
                insurance: null,
                accommodation: null,
                catering: null,
                moreWelfares: null,
                memo: null,
                promotion: null,
              },
              hiringRequirements: {
                minAge: 18,
                maxAge: 35,
              },
            },
            {
              id: "pos-2",
              name: "后厨帮工",
              sourceJobName: "必胜客-万达广场-后厨帮工-兼职",
              jobCategory: "后厨",
              brandId: "brand-1",
              brandName: "必胜客",
              description: "负责后厨协助",
              laborForm: "兼职",
              employmentForm: "长期用工",
              trainingRequired: "不需要",
              probationRequired: "不需要",
              salary: {
                base: 20,
                unit: "元/小时",
                memo: "时薪",
              },
              timeSlots: ["10:00~15:00"],
              workHours: "5",
              minHoursPerWeek: null,
              maxHoursPerWeek: null,
              perMonthMinWorkTime: null,
              perMonthMinWorkTimeUnit: null,
              availableSlots: [],
              benefits: {
                insurance: null,
                accommodation: null,
                catering: null,
                moreWelfares: null,
                memo: null,
                promotion: null,
              },
            },
          ],
        },
        {
          id: "store-2",
          brandId: "brand-1",
          name: "广州天河城店",
          city: "广州",
          location: "天河区体育西路",
          district: "天河区",
          subarea: "体育西",
          coordinates: { lng: 113.321, lat: 23.132 },
          positions: [
            {
              id: "pos-3",
              name: "配送员",
              sourceJobName: "必胜客-天河城-配送员-兼职",
              jobCategory: "配送",
              brandId: "brand-1",
              brandName: "必胜客",
              description: "负责门店配送",
              laborForm: "兼职",
              employmentForm: "长期用工",
              trainingRequired: "不需要",
              probationRequired: "不需要",
              salary: {
                base: 24,
                unit: "元/小时",
                memo: "时薪",
              },
              timeSlots: ["11:00~18:00"],
              workHours: "6",
              minHoursPerWeek: null,
              maxHoursPerWeek: null,
              perMonthMinWorkTime: null,
              perMonthMinWorkTimeUnit: null,
              availableSlots: [],
              benefits: {
                insurance: null,
                accommodation: null,
                catering: null,
                moreWelfares: null,
                memo: null,
                promotion: null,
              },
              hiringRequirements: {
                minAge: 20,
                maxAge: 40,
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("evaluateAgeEligibility", () => {
  it("returns pass when at least one evidence item matches age", () => {
    const result = evaluateAgeEligibility({
      age: 22,
      evidence: [
        { minAge: 18, maxAge: 35 },
        { minAge: 20, maxAge: 40 },
      ],
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(result.summary, {
      minAgeObserved: 18,
      maxAgeObserved: 40,
      matchedCount: 2,
      total: 2,
    });
  });

  it("returns fail when evidence ranges exclude the candidate age", () => {
    const result = evaluateAgeEligibility({
      age: 17,
      evidence: [{ minAge: 18, maxAge: 35 }],
    });

    assert.equal(result.status, "fail");
  });

  it("returns unknown when evidence is empty", () => {
    const result = evaluateAgeEligibility({
      age: 22,
      evidence: [],
    });

    assert.equal(result.status, "unknown");
    assert.deepEqual(result.summary, {
      minAgeObserved: null,
      maxAgeObserved: null,
      matchedCount: 0,
      total: 0,
    });
  });

  it("returns unknown when evidence exists but no age range is available", () => {
    const result = evaluateAgeEligibility({
      age: 22,
      evidence: [{ minAge: null, maxAge: null }],
    });

    assert.equal(result.status, "unknown");
    assert.deepEqual(result.summary, {
      minAgeObserved: null,
      maxAgeObserved: null,
      matchedCount: 1,
      total: 1,
    });
  });
});

describe("createConfigDataAgeSource", () => {
  it("extracts age evidence from matching configData positions", async () => {
    const source = createConfigDataAgeSource(sampleData);
    const evidence = await source.collect({
      brandAlias: "佛山必胜客",
      cityName: "佛山",
      regionName: "南海",
    });

    assert.deepEqual(evidence, {
      evidence: [
        { minAge: 18, maxAge: 35 },
        { minAge: null, maxAge: null },
      ],
      matchedCount: 2,
      total: 2,
      isComplete: true,
    });
  });

  it("returns an empty collection when brand or city does not match", async () => {
    const source = createConfigDataAgeSource(sampleData);
    const evidence = await source.collect({
      brandAlias: "肯德基",
      cityName: "深圳",
    });

    assert.deepEqual(evidence, {
      evidence: [],
      matchedCount: 0,
      total: 0,
      isComplete: true,
    });
  });
});

describe("collectAgeEvidenceFromSources", () => {
  it("falls back when the higher-priority source has no usable age range", async () => {
    let fallbackCalls = 0;
    const sources: AgeEligibilitySource[] = [
      {
        name: "config-data",
        async collect() {
          return [{ minAge: null, maxAge: null }];
        },
      },
      {
        name: "duliday-api",
        async collect() {
          fallbackCalls += 1;
          return [{ minAge: 18, maxAge: 35 }];
        },
      },
    ];

    const evidence = await collectAgeEvidenceFromSources({ sources, cityName: "佛山" });

    assert.equal(fallbackCalls, 1);
    assert.deepEqual(evidence, {
      evidence: [{ minAge: 18, maxAge: 35 }],
      matchedCount: 1,
      total: 1,
      isComplete: true,
    });
  });

  it("returns an empty collection when all sources throw", async () => {
    const sources: AgeEligibilitySource[] = [
      {
        name: "config-data",
        async collect() {
          throw new Error("config error");
        },
      },
      {
        name: "duliday-api",
        async collect() {
          throw new Error("api error");
        },
      },
    ];

    const evidence = await collectAgeEvidenceFromSources({ sources, cityName: "佛山" });

    assert.deepEqual(evidence, {
      evidence: [],
      matchedCount: 0,
      total: 0,
      isComplete: true,
    });
  });
});

describe("createDefaultAgeEligibilitySources", () => {
  it("always includes configData and appends Duliday only when runtime config is complete", () => {
    const configOnly = createDefaultAgeEligibilitySources({ configData: sampleData });
    const withFallback = createDefaultAgeEligibilitySources({
      configData: sampleData,
      token: "token",
      jobListUrl: "https://example.com/job-list",
    });

    assert.equal(configOnly.length, 1);
    assert.equal(withFallback.length, 2);
    assert.equal(configOnly[0]!.name, "config-data");
    assert.equal(withFallback[1]!.name, "duliday-api");
  });
});
