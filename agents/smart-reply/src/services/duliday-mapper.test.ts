import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertPositionsToZhipinData,
  parseSalaryDetails,
  parseBenefits,
  generateRequirements,
  buildScenarioSummary,
  extractSettlementCycle,
  parseTimeStringToSeconds,
} from "./duliday-mapper.ts";
import type { RequirementsInput } from "./duliday-mapper.ts";
import type { DulidayNewWelfare } from "../types/duliday-api.ts";

// ========== 最小有效 position 工厂 ==========

function makeMinimalPosition(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    basicInfo: {
      jobId: 1001,
      jobName: "上海-浦东新区-服务员-兼职",
      jobContent: "负责门店服务",
      brandId: 42,
      brandName: "测试品牌",
      projectId: 42,
      projectName: "测试项目",
      storeInfo: {
        storeId: 2001,
        storeName: "佘山宝地附近门店",
        storeCityName: "上海市",
        storeRegionName: "浦东新区",
        storeAddress: "上海-浦东新区-张江",
        longitude: 121.5,
        latitude: 31.2,
      },
    },
    jobSalary: {
      salary: 22,
      salaryUnitStr: "元/小时",
      salaryScenarioList: [
        {
          salaryType: "正式",
          salaryPeriod: "月结算",
          basicSalary: { basicSalary: 22, basicSalaryUnit: "元/小时" },
        },
      ],
    },
    welfare: {
      haveInsurance: "有",
      accommodation: "无",
      memo: "综合收入5250元-5750元，奖金1000～1500",
      moreWelfares: [{ content: "年假5天", image: null }],
    },
    hiringRequirement: {
      cooperationMode: 2,
      requirementNum: 5,
      thresholdNum: 3,
      signUpNum: 2,
      basicPersonalRequirements: {
        minAge: 18,
        maxAge: 45,
        genderRequirement: "男性,女性",
      },
      certificate: {
        education: "高中",
        healthCertificate: "食品健康证",
      },
    },
    workTime: {
      employmentForm: "长期用工",
      maxWorkTakingTime: 120,
      workTimeRemark: "每周至少3天",
      weekWorkTime: {
        perWeekWorkDays: 3,
        perWeekRestDays: 4,
      },
      dayWorkTime: {
        perDayMinWorkHours: 4,
      },
      dailyShiftSchedule: {
        arrangementType: "组合排班制",
        combinedArrangement: [
          {
            startTime: 36000,
            endTime: 50400,
            weekdays: [1, 2, 3, 4, 5],
          },
        ],
      },
    },
    ...overrides,
  };
}

// ========== convertPositionsToZhipinData ==========

describe("convertPositionsToZhipinData", () => {
  it("converts minimal valid input to correct ZhipinData", () => {
    const positions = [makeMinimalPosition()];
    const result = convertPositionsToZhipinData(positions, "测试品牌", "上海市");

    assert.equal(result.meta.defaultBrandId, "42");
    assert.equal(result.meta.source, "duliday");
    assert.equal(result.brands.length, 1);
    assert.equal(result.brands[0]!.name, "测试品牌");

    const store = result.brands[0]!.stores[0]!;
    assert.equal(store.id, "store_2001");
    assert.equal(store.name, "佘山宝地附近门店");
    assert.equal(store.district, "浦东新区");
    assert.equal(store.brandId, "42");
    assert.equal(store.positions.length, 1);

    const pos = store.positions[0]!;
    assert.equal(pos.id, "pos_1001");
    assert.equal(pos.name, "服务员");
    assert.equal(pos.brandId, "42");
    assert.equal(pos.brandName, "测试品牌");
    assert.equal(pos.salary.base, 22);
    assert.equal(pos.scheduleType, "flexible");
    assert.equal(pos.urgent, true);
    assert.equal(pos.description, "负责门店服务");
  });

  it("handles empty positions array", () => {
    const result = convertPositionsToZhipinData([], "品牌A");
    assert.equal(result.brands.length, 0);
    assert.equal(result.meta.defaultBrandId, undefined);
    assert.equal(result.meta.source, "duliday");
  });

  it("aggregates multiple positions into same store", () => {
    const pos1 = makeMinimalPosition();
    const pos2 = makeMinimalPosition();
    // Override jobId/jobName to create a different position in the same store
    (pos2.basicInfo as Record<string, unknown>).jobId = 1002;
    (pos2.basicInfo as Record<string, unknown>).jobName = "上海-浦东新区-经理-全职";
    const result = convertPositionsToZhipinData([pos1, pos2], "品牌B");
    assert.equal(result.brands.length, 1);
    assert.equal(result.brands[0]!.stores.length, 1);
    assert.equal(result.brands[0]!.stores[0]!.positions.length, 2);
  });

  it("skips invalid positions gracefully", () => {
    const result = convertPositionsToZhipinData(
      [makeMinimalPosition(), { invalid: true }, null, 42],
      "品牌C",
    );
    assert.equal(result.brands.length, 1);
    assert.equal(result.brands[0]!.stores.length, 1);
    assert.equal(result.brands[0]!.stores[0]!.positions.length, 1);
  });

  it("uses the first position as default brand when no override is provided", () => {
    const result = convertPositionsToZhipinData([makeMinimalPosition()], "品牌D");
    assert.equal(result.meta.defaultBrandId, "42");
  });

  it("handles missing storeId with fallback hash", () => {
    const pos = makeMinimalPosition();
    // Replace storeInfo to one without storeId — triggers hash fallback
    (pos.basicInfo as Record<string, unknown>).storeInfo = { storeName: "未知门店" };
    const result = convertPositionsToZhipinData([pos], "品牌E");
    assert.equal(result.brands.length, 1);
    assert.equal(result.brands[0]!.stores.length, 1);
    assert.ok(result.brands[0]!.stores[0]!.id.startsWith("store_"));
  });
});

// ========== parseSalaryDetails ==========

describe("parseSalaryDetails", () => {
  const makeWelfare = (memo: string): DulidayNewWelfare => ({
    haveInsurance: "无",
    accommodation: "无",
    memo,
  });

  it("extracts salary range from memo", () => {
    const result = parseSalaryDetails(20, makeWelfare("综合收入5250元-5750元"));
    assert.equal(result.base, 20);
    assert.equal(result.range, "5250元-5750元");
  });

  it("extracts bonus from memo", () => {
    const result = parseSalaryDetails(20, makeWelfare("季度奖金1000～1500"));
    assert.equal(result.bonus, "奖金1000～1500");
  });

  it("handles empty memo", () => {
    const result = parseSalaryDetails(15, makeWelfare(""));
    assert.equal(result.base, 15);
    assert.equal(result.range, undefined);
    assert.equal(result.bonus, undefined);
    assert.equal(result.memo, "");
  });

  it("handles null memo", () => {
    const result = parseSalaryDetails(15, { haveInsurance: "无", accommodation: "无", memo: null });
    assert.equal(result.memo, "");
  });
});

// ========== parseBenefits ==========

describe("parseBenefits", () => {
  it("detects insurance from string '有'", () => {
    const result = parseBenefits({ haveInsurance: "有", accommodation: "无" });
    assert.ok(result.items.includes("五险一金"));
  });

  it("does not add insurance for '无'", () => {
    const result = parseBenefits({ haveInsurance: "无", accommodation: "无" });
    assert.ok(!result.items.includes("五险一金"));
  });

  it("detects accommodation and catering", () => {
    const result = parseBenefits({
      haveInsurance: "无",
      accommodation: "有",
      catering: "有",
    });
    assert.ok(result.items.includes("住宿"));
    assert.ok(result.items.includes("餐饮"));
  });

  it("extracts from moreWelfares", () => {
    const result = parseBenefits({
      haveInsurance: "无",
      accommodation: "无",
      moreWelfares: [{ content: "年假5天福利" }],
    });
    assert.ok(result.items.some((i) => i.includes("年假")));
  });

  it("falls back to default when no benefits", () => {
    const result = parseBenefits({ haveInsurance: "无", accommodation: "无" });
    assert.ok(result.items.includes("按国家规定"));
  });
});

// ========== generateRequirements ==========

describe("generateRequirements", () => {
  it("generates age requirement", () => {
    const input: RequirementsInput = {
      basicPersonalRequirements: { minAge: 18, maxAge: 45 },
      certificate: null,
      jobName: "测试",
    };
    const reqs = generateRequirements(input);
    assert.ok(reqs.some((r) => r.includes("年龄18-45岁")));
  });

  it("generates education requirement", () => {
    const input: RequirementsInput = {
      basicPersonalRequirements: null,
      certificate: { education: "高中" },
      jobName: "测试",
    };
    const reqs = generateRequirements(input);
    assert.ok(reqs.some((r) => r.includes("高中及以上")));
  });

  it("generates health certificate requirement", () => {
    const input: RequirementsInput = {
      basicPersonalRequirements: null,
      certificate: { healthCertificate: "食品健康证" },
      jobName: "测试",
    };
    const reqs = generateRequirements(input);
    assert.ok(reqs.some((r) => r.includes("需食品健康证")));
  });

  it("falls back to defaults when no structured data", () => {
    const input: RequirementsInput = {
      basicPersonalRequirements: null,
      certificate: null,
      jobName: "门店-服务员-兼职",
    };
    const reqs = generateRequirements(input);
    assert.ok(reqs.some((r) => r.includes("服务行业")));
  });
});

// ========== buildScenarioSummary ==========

describe("buildScenarioSummary", () => {
  it("builds stair salary summary", () => {
    const result = buildScenarioSummary([
      {
        salaryType: "正式",
        stairSalaries: [
          { fullWorkTime: 100, fullWorkTimeUnit: "小时", salary: 25, salaryUnit: "元/时" },
        ],
      },
    ]);
    assert.ok(result?.includes("满100小时后25元/时"));
  });

  it("builds comprehensive salary summary", () => {
    const result = buildScenarioSummary([
      {
        salaryType: "正式",
        comprehensiveSalary: {
          minComprehensiveSalary: 5000,
          maxComprehensiveSalary: 7000,
          comprehensiveSalaryUnit: "元/月",
        },
      },
    ]);
    assert.ok(result?.includes("综合5000-7000元/月"));
  });

  it("builds holiday salary summary", () => {
    const result = buildScenarioSummary([
      {
        salaryType: "正式",
        holidaySalary: { holidaySalaryMultiple: 2 },
      },
    ]);
    assert.ok(result?.includes("节假日2倍"));
  });

  it("skips training period scenarios", () => {
    const result = buildScenarioSummary([
      {
        salaryType: "培训期",
        stairSalaries: [{ fullWorkTime: 50, salary: 18 }],
      },
    ]);
    assert.equal(result, undefined);
  });

  it("returns undefined for empty scenarios", () => {
    assert.equal(buildScenarioSummary(null), undefined);
    assert.equal(buildScenarioSummary([]), undefined);
  });
});

// ========== extractSettlementCycle ==========

describe("extractSettlementCycle", () => {
  it("maps 月结算 to 月结", () => {
    const result = extractSettlementCycle([{ salaryType: "正式", salaryPeriod: "月结算" }]);
    assert.equal(result, "月结");
  });

  it("maps 日结算 to 日结", () => {
    const result = extractSettlementCycle([{ salaryType: "正式", salaryPeriod: "日结算" }]);
    assert.equal(result, "日结");
  });

  it("returns undefined for unknown period", () => {
    const result = extractSettlementCycle([{ salaryType: "正式", salaryPeriod: "unknown" }]);
    assert.equal(result, undefined);
  });

  it("returns undefined for empty scenarios", () => {
    assert.equal(extractSettlementCycle(null), undefined);
  });
});

// ========== parseTimeStringToSeconds ==========

describe("parseTimeStringToSeconds", () => {
  it("parses HH:MM format", () => {
    assert.equal(parseTimeStringToSeconds("14:00"), 50400);
    assert.equal(parseTimeStringToSeconds("0:00"), 0);
    assert.equal(parseTimeStringToSeconds("23:59"), 86340);
  });

  it("handles numeric input", () => {
    assert.equal(parseTimeStringToSeconds(3600), 3600);
  });

  it("handles empty/null input", () => {
    assert.equal(parseTimeStringToSeconds(""), 0);
    assert.equal(parseTimeStringToSeconds(null), 0);
    assert.equal(parseTimeStringToSeconds(undefined), 0);
  });
});
