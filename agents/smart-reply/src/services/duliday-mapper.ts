import { DulidayNewPositionSchema } from "../types/duliday-api.ts";
import type {
  DulidaySalaryScenario,
  DulidayNewWelfare,
  DulidayNewWorkTime,
} from "../types/duliday-api.ts";
import type {
  ZhipinData,
  Brand,
  Store,
  Position,
  SalaryDetails,
  Benefits,
  TimeSlotAvailability,
  AttendanceRequirement,
  HiringRequirements,
} from "../types/zhipin.ts";

// ========== ParsedPosition 中间类型 ==========

type ParsedPosition = {
  jobId: number;
  jobName: string;
  jobNickName: string | null;
  jobCategoryName: string | null;
  jobContent: string | null;
  laborForm: string | null;
  employmentForm: string;
  trainingRequired: string | null;
  probationRequired: string | null;
  brandId: string | undefined;
  brandName: string | undefined;
  projectId: number | undefined;
  projectName: string | undefined;
  storeId: number;
  storeName: string;
  storeCityName: string;
  storeRegionName: string | undefined;
  storeAddress: string;
  longitude: number | undefined;
  latitude: number | undefined;
  salary: number | null;
  salaryUnitStr: string | null;
  salaryScenarioList: DulidaySalaryScenario[] | null;
  welfare: DulidayNewWelfare;
  requirementNum: number;
  signUpNum: number | null;
  basicPersonalRequirements: {
    minAge?: number | null;
    maxAge?: number | null;
    genderRequirement?: string | null;
  } | null;
  certificate: {
    education?: string | null;
    healthCertificate?: string | null;
  } | null;
  languages: string | null;
  certificatesRaw: string | null;
  recruitmentRemark: string | null;
  workTime: DulidayNewWorkTime;
  perMonthMinWorkTime: number | null;
};

// ========== 解析入口 ==========

function parsePosition(raw: unknown): ParsedPosition | null {
  const parsed = DulidayNewPositionSchema.safeParse(raw);
  if (!parsed.success) return null;

  const pos = parsed.data;
  const basic = pos.basicInfo;
  const store = basic.storeInfo;
  const salary = pos.jobSalary;
  const hiring = pos.hiringRequirement;

  const resolvedSalary =
    salary.salary ??
    salary.salaryScenarioList?.find((s) => s.salaryType === "正式")?.basicSalary?.basicSalary ??
    salary.salaryScenarioList?.[0]?.basicSalary?.basicSalary ??
    null;

  const resolvedSalaryUnit =
    salary.salaryUnitStr ??
    salary.salaryScenarioList?.find((s) => s.salaryType === "正式")?.basicSalary?.basicSalaryUnit ??
    salary.salaryScenarioList?.[0]?.basicSalary?.basicSalaryUnit ??
    null;

  // storeId fallback: hash from storeName+address
  let storeId = store?.storeId;
  if (storeId == null) {
    const source = `${store?.storeName ?? ""}|${store?.storeAddress ?? ""}`;
    storeId = Array.from(source).reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7);
  }

  return {
    jobId: basic.jobId,
    jobName: basic.jobName,
    jobNickName: basic.jobNickName ?? null,
    jobCategoryName: basic.jobCategoryName ?? null,
    jobContent: basic.jobContent ?? null,
    laborForm: basic.laborForm ?? null,
    employmentForm: pos.workTime.employmentForm,
    trainingRequired: basic.needTraining ?? null,
    probationRequired: basic.needProbationWork ?? null,
    brandId:
      basic.brandId !== undefined
        ? String(basic.brandId)
        : basic.projectId !== undefined
          ? String(basic.projectId)
          : undefined,
    brandName: basic.brandName,
    projectId: basic.projectId,
    projectName: basic.projectName,
    storeId,
    storeName: store?.storeName ?? "未知门店",
    storeCityName: store?.storeCityName ?? "",
    storeRegionName: store?.storeRegionName,
    storeAddress: store?.storeAddress ?? "",
    longitude: store?.longitude,
    latitude: store?.latitude,
    salary: resolvedSalary,
    salaryUnitStr: resolvedSalaryUnit,
    salaryScenarioList: salary.salaryScenarioList ?? null,
    welfare: pos.welfare,
    requirementNum: hiring.requirementNum ?? 0,
    signUpNum: hiring.signUpNum ?? null,
    basicPersonalRequirements: hiring.basicPersonalRequirements
      ? {
          minAge: hiring.basicPersonalRequirements.minAge ?? null,
          maxAge: hiring.basicPersonalRequirements.maxAge ?? null,
          genderRequirement: hiring.basicPersonalRequirements.genderRequirement ?? null,
        }
      : null,
    certificate: hiring.certificate
      ? {
          education: hiring.certificate.education ?? null,
          healthCertificate: hiring.certificate.healthCertificate ?? null,
        }
      : null,
    languages: hiring.language?.languages ?? null,
    certificatesRaw: hiring.certificate?.certificates ?? null,
    recruitmentRemark: hiring.remark ?? null,
    workTime: pos.workTime,
    perMonthMinWorkTime: pos.workTime.monthWorkTime?.perMonthMinWorkTime ?? null,
  };
}

// ========== 核心入口 ==========

export function convertPositionsToZhipinData(
  rawPositions: unknown[],
  preferredDefaultBrandName?: string | undefined,
  cityName?: string | undefined,
): ZhipinData {
  const brands = new Map<string, Brand>();
  let defaultBrandId: string | undefined;

  for (let i = 0; i < rawPositions.length; i++) {
    const parsed = parsePosition(rawPositions[i]);
    if (!parsed) continue;

    const resolvedBrandName = parsed.brandName ?? preferredDefaultBrandName ?? "未知品牌";
    const resolvedBrandId = parsed.brandId ?? `name:${resolvedBrandName}`;

    if (
      defaultBrandId === undefined &&
      (preferredDefaultBrandName === undefined || resolvedBrandName === preferredDefaultBrandName)
    ) {
      defaultBrandId = resolvedBrandId;
    }

    let brand = brands.get(resolvedBrandId);
    if (!brand) {
      brand = {
        id: resolvedBrandId,
        name: resolvedBrandName,
        stores: [],
      };
      brands.set(resolvedBrandId, brand);
    }

    const storeKey = `store_${parsed.storeId}`;
    let store = brand.stores.find((item) => item.id === storeKey);
    if (!store) {
      store = convertToStore(parsed, resolvedBrandId, cityName);
      brand.stores.push(store);
    }

    const position = convertToPosition(parsed);
    store.positions.push(position);
  }

  return {
    meta: {
      ...((defaultBrandId ?? brands.values().next().value?.id)
        ? { defaultBrandId: defaultBrandId ?? brands.values().next().value?.id }
        : {}),
      syncedAt: new Date().toISOString(),
      source: "duliday",
    },
    brands: Array.from(brands.values()),
  };
}

// ========== Store / Position 转换 ==========

function convertToStore(
  p: ParsedPosition,
  brandId: string,
  fallbackCity?: string | undefined,
): Store {
  return {
    id: `store_${p.storeId}`,
    brandId,
    name: p.storeName,
    city: p.storeCityName || fallbackCity,
    location: p.storeAddress,
    district: extractDistrict(p.storeAddress, p.storeRegionName),
    subarea: extractSubarea(p.storeName),
    coordinates:
      typeof p.latitude === "number" && typeof p.longitude === "number"
        ? { lat: p.latitude, lng: p.longitude }
        : { lat: 0, lng: 0 },
    positions: [],
  };
}

function convertToPosition(p: ParsedPosition): Position {
  const wta = normalizeNewWorkTime(p.workTime);

  let timeSlots: string[] = [];
  if (wta.combinedArrangementTimes?.length) {
    timeSlots = convertTimeSlots(wta.combinedArrangementTimes);
  } else if (wta.fixedArrangementTimes?.length) {
    timeSlots = convertTimeSlots(wta.fixedArrangementTimes.map((s) => ({ ...s, weekdays: [] })));
  }

  return {
    // 基础信息
    id: `pos_${p.jobId}`,
    name: p.jobNickName ?? extractPositionType(p.jobName),
    sourceJobName: p.jobName,
    jobCategory: p.jobCategoryName,
    brandId: p.brandId,
    brandName: p.brandName,
    projectId: p.projectId !== undefined ? String(p.projectId) : undefined,
    projectName: p.projectName,
    description: p.jobContent || null,

    // 用工形式
    laborForm: p.laborForm,
    employmentForm: p.employmentForm,
    trainingRequired: p.trainingRequired,
    probationRequired: p.probationRequired,

    // 薪资
    salary: {
      ...parseSalaryDetails(p.salary, p.salaryUnitStr, p.welfare),
      scenarioSummary: buildScenarioSummary(p.salaryScenarioList),
      settlementCycle: extractSettlementCycle(p.salaryScenarioList),
    },

    // 排班与工时
    timeSlots,
    workHours: wta.perDayMinWorkHours != null ? String(wta.perDayMinWorkHours) : null,
    minHoursPerWeek: calculateMinHoursPerWeek(wta),
    maxHoursPerWeek: calculateMaxHoursPerWeek(wta),
    perMonthMinWorkTime: p.perMonthMinWorkTime,
    attendanceRequirement: generateAttendanceRequirement(wta),

    // 可用时段
    availableSlots: generateAvailableSlots(p, wta),

    // 福利
    benefits: parseBenefits(p.welfare),

    // 招聘要求
    hiringRequirements: extractHiringRequirements(p),
  };
}

// ========== WorkTime 归一化 ==========

type FlatWorkTime = {
  perDayMinWorkHours: number | null;
  perWeekWorkDays: number | null;
  perWeekNeedWorkDays: number | null;
  perWeekRestDays: number | null;
  arrangementType: number;
  maxWorkTakingTime: number;
  workTimeRemark: string | null;
  fixedArrangementTimes: Array<{ startTime: number; endTime: number }> | null;
  combinedArrangementTimes: Array<{
    startTime: number;
    endTime: number;
    weekdays: number[];
  }> | null;
  customWorkTimes: Array<{
    weekdays: number[];
    minWorkDays: number | null;
    maxWorkDays: number | null;
  }> | null;
};

function normalizeNewWorkTime(nwt: DulidayNewWorkTime): FlatWorkTime {
  const week = nwt.weekWorkTime;
  const day = nwt.dayWorkTime;
  const schedule = nwt.dailyShiftSchedule;

  const arrangementTypeMap: Record<string, number> = { 固定排班制: 1, 组合排班制: 3 };
  const arrangementType =
    Number(schedule?.arrangementType) ||
    (arrangementTypeMap[String(schedule?.arrangementType)] ?? 0);

  const rawPerDay = day?.perDayMinWorkHours != null ? Number(day.perDayMinWorkHours) : null;
  const perDayMinWorkHours = rawPerDay !== null && Number.isFinite(rawPerDay) ? rawPerDay : null;

  const customWorkTimes =
    week?.customnWorkTimeList?.map((item) => ({
      weekdays: Array.isArray(item.customWorkWeekdays)
        ? item.customWorkWeekdays.map((d) => Number(d)).filter((d) => Number.isFinite(d))
        : [],
      minWorkDays: item.customMinWorkDays ?? null,
      maxWorkDays: item.customMaxWorkDays ?? null,
    })) ?? null;

  const fixedArrangementTimes =
    schedule?.fixedScheduleList?.map((item) => ({
      startTime: item.startTime ?? parseTimeStringToSeconds(item.fixedShiftStartTime),
      endTime: item.endTime ?? parseTimeStringToSeconds(item.fixedShiftEndTime),
    })) ?? null;

  const combinedArrangementTimes =
    schedule?.combinedArrangement?.map((item) => {
      const rawWeekdays =
        item.weekdays ??
        (typeof item.CombinedArrangementWeekdays === "string"
          ? [Number(item.CombinedArrangementWeekdays)]
          : Array.isArray(item.CombinedArrangementWeekdays)
            ? item.CombinedArrangementWeekdays
            : []);
      const weekdays = rawWeekdays
        .map((d: unknown) => (typeof d === "number" ? d : Number(d)))
        .filter((d: number) => Number.isFinite(d));
      return {
        startTime: item.startTime ?? item.CombinedArrangementStartTime ?? 0,
        endTime: item.endTime ?? item.CombinedArrangementEndTime ?? 0,
        weekdays,
      };
    }) ?? null;

  return {
    perDayMinWorkHours,
    perWeekWorkDays: week?.perWeekWorkDays ?? null,
    perWeekNeedWorkDays:
      week?.perWeekNeedWorkDays != null ? Number(week.perWeekNeedWorkDays) : null,
    perWeekRestDays: week?.perWeekRestDays ?? null,
    arrangementType,
    maxWorkTakingTime: nwt.maxWorkTakingTime ?? 0,
    workTimeRemark: nwt.workTimeRemark ?? null,
    fixedArrangementTimes,
    combinedArrangementTimes,
    customWorkTimes,
  };
}

// ========== 薪资 ==========

export function parseSalaryDetails(
  baseSalary: number | null,
  salaryUnit: string | null,
  welfare: DulidayNewWelfare,
): SalaryDetails {
  const memo = welfare.memo || "";
  const rangeMatch = memo.match(/(\d+元?-\d+元?)/);
  const range = rangeMatch ? rangeMatch[1] : undefined;
  const bonusMatch = memo.match(/(奖金[\d～\-~元]+)/);
  const bonus = bonusMatch ? bonusMatch[1] : undefined;

  return { base: baseSalary, unit: salaryUnit, range, bonus, memo };
}

export function buildScenarioSummary(
  scenarios: DulidaySalaryScenario[] | null | undefined,
): string | undefined {
  if (!scenarios || scenarios.length === 0) return undefined;

  const parts: string[] = [];
  for (const s of scenarios) {
    if (s.salaryType === "培训期") continue;

    if (s.stairSalaries?.length) {
      const stairs = s.stairSalaries
        .filter((st) => st.salary != null)
        .map((st) => {
          const unit = st.salaryUnit ?? "元/时";
          return `满${st.fullWorkTime ?? "?"}${st.fullWorkTimeUnit ?? "小时"}后${st.salary}${unit}`;
        })
        .join("，");
      if (stairs) parts.push(stairs);
    }

    const comp = s.comprehensiveSalary;
    if (comp?.minComprehensiveSalary != null && comp?.maxComprehensiveSalary != null) {
      parts.push(
        `综合${comp.minComprehensiveSalary}-${comp.maxComprehensiveSalary}${comp.comprehensiveSalaryUnit ?? "元/月"}`,
      );
    }

    const holiday = s.holidaySalary;
    if (holiday) {
      if (holiday.holidaySalaryMultiple) {
        parts.push(`节假日${holiday.holidaySalaryMultiple}倍`);
      } else if (holiday.holidayFixedSalary != null) {
        parts.push(
          `节假日${holiday.holidayFixedSalary}${holiday.holidayFixedSalaryUnit ?? "元/时"}`,
        );
      }
    }
  }

  return parts.length > 0 ? parts.join("；") : undefined;
}

export function extractSettlementCycle(
  scenarios: DulidaySalaryScenario[] | null | undefined,
): string | undefined {
  if (!scenarios || scenarios.length === 0) return undefined;

  const cycleMap: Record<string, string> = {
    日结算: "日结",
    周结算: "周结",
    月结算: "月结",
    完结算: "完结",
    半月结算: "半月结",
  };
  const primary = scenarios.find((s) => s.salaryType === "正式") ?? scenarios[0];
  return cycleMap[primary?.salaryPeriod ?? ""] ?? undefined;
}

// ========== 福利 ==========

export function parseBenefits(welfare: DulidayNewWelfare): Benefits {
  const moreWelfares =
    welfare.moreWelfares && Array.isArray(welfare.moreWelfares) && welfare.moreWelfares.length > 0
      ? welfare.moreWelfares.map((item) => item.content)
      : null;

  return {
    insurance: welfare.haveInsurance || null,
    accommodation: welfare.accommodation || null,
    catering: welfare.catering ?? null,
    moreWelfares,
    memo: welfare.memo ?? null,
    promotion: welfare.promotionWelfare ?? null,
  };
}

// ========== 招聘要求 ==========

function extractHiringRequirements(p: ParsedPosition): HiringRequirements | undefined {
  const bpr = p.basicPersonalRequirements;
  const cert = p.certificate;
  if (!bpr && !cert && !p.languages && !p.certificatesRaw && !p.recruitmentRemark) {
    return undefined;
  }

  return {
    minAge: bpr?.minAge ?? null,
    maxAge: bpr?.maxAge ?? null,
    genderRequirement: bpr?.genderRequirement ?? null,
    education: cert?.education ?? null,
    healthCertificate: cert?.healthCertificate ?? null,
    languages: p.languages,
    certificatesRaw: p.certificatesRaw,
    recruitmentRemark: p.recruitmentRemark,
  };
}

// ========== 可用时段 ==========

function generateAvailableSlots(p: ParsedPosition, wta: FlatWorkTime): TimeSlotAvailability[] {
  const slots: TimeSlotAvailability[] = [];
  let timeSlots: string[] = [];

  if (wta.combinedArrangementTimes?.length) {
    timeSlots = convertTimeSlots(wta.combinedArrangementTimes);
  } else if (wta.fixedArrangementTimes?.length) {
    timeSlots = convertTimeSlots(wta.fixedArrangementTimes.map((s) => ({ ...s, weekdays: [] })));
  }

  for (const slot of timeSlots) {
    slots.push({
      slot,
      maxCapacity: p.requirementNum,
      currentBooked: p.signUpNum || 0,
      isAvailable: (p.signUpNum || 0) < p.requirementNum,
      priority: p.requirementNum > 3 ? "high" : "medium",
    });
  }

  return slots;
}

// ========== 工时计算 ==========

function calculateMinHoursPerWeek(wta: FlatWorkTime): number | null {
  const dailyHours = wta.perDayMinWorkHours;
  if (dailyHours == null) return null;

  let workDays: number | null = null;

  if (wta.perWeekWorkDays != null) {
    workDays = wta.perWeekWorkDays;
  }

  if (workDays === null && wta.customWorkTimes?.length) {
    const minWorkDaysArray = wta.customWorkTimes
      .map((ct) => ct.minWorkDays)
      .filter((days): days is number => days !== null && days !== undefined);
    if (minWorkDaysArray.length > 0) {
      workDays = Math.min(...minWorkDaysArray);
    }
  }

  if (workDays === null && wta.perWeekNeedWorkDays != null) {
    workDays = wta.perWeekNeedWorkDays;
  }

  if (workDays === null) return null;

  return dailyHours * workDays;
}

function calculateMaxHoursPerWeek(wta: FlatWorkTime): number | null {
  const dailyHours = wta.perDayMinWorkHours;
  if (dailyHours == null || wta.perWeekWorkDays == null) return null;
  const maxDays = wta.perWeekWorkDays;
  return dailyHours * maxDays;
}

function generateAttendanceRequirement(wta: FlatWorkTime): AttendanceRequirement {
  let requiredDays: number[] = [];

  if (wta.combinedArrangementTimes?.length) {
    const allDays = new Set<number>();
    for (const slot of wta.combinedArrangementTimes) {
      for (const day of slot.weekdays) {
        if (day != null && Number.isFinite(day)) allDays.add(day);
      }
    }
    requiredDays = Array.from(allDays).sort();
  } else if (wta.customWorkTimes?.length) {
    const allDays = new Set<number>();
    for (const customTime of wta.customWorkTimes) {
      for (const day of customTime.weekdays) {
        if (day != null && Number.isFinite(day)) allDays.add(day);
      }
    }
    requiredDays = Array.from(allDays).sort();
  }

  let minimumDays: number | null = null;

  if (wta.perWeekWorkDays != null) {
    minimumDays = wta.perWeekWorkDays;
  }
  if (minimumDays === null && wta.customWorkTimes?.length) {
    const minWorkDaysArray = wta.customWorkTimes
      .map((ct) => ct.minWorkDays)
      .filter((days): days is number => days !== null && days !== undefined);
    if (minWorkDaysArray.length > 0) {
      minimumDays = Math.min(...minWorkDaysArray);
    }
  }
  if (minimumDays === null && wta.perWeekNeedWorkDays != null) {
    minimumDays = wta.perWeekNeedWorkDays;
  }
  return {
    minimumDays,
    requiredDays: convertWeekdays(requiredDays),
    description: wta.workTimeRemark || "",
  };
}

// ========== 时间工具 ==========

export function parseTimeStringToSeconds(timeStr: unknown): number {
  if (typeof timeStr === "number") return timeStr;
  if (typeof timeStr !== "string" || !timeStr) return 0;
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return Number(timeStr) || 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

function convertTimeSlots(
  slots: Array<{ startTime: number; endTime: number; weekdays?: number[] }>,
): string[] {
  return slots.map((slot) => {
    const startHour = Math.floor(slot.startTime / 3600);
    const startMin = Math.floor((slot.startTime % 3600) / 60);
    const endHour = Math.floor(slot.endTime / 3600);
    const endMin = Math.floor((slot.endTime % 3600) / 60);
    return `${startHour.toString().padStart(2, "0")}:${startMin.toString().padStart(2, "0")}~${endHour.toString().padStart(2, "0")}:${endMin.toString().padStart(2, "0")}`;
  });
}

// ========== 地理 / 名称工具 ==========

function extractDistrict(storeAddress: string, storeRegionName?: string): string | null {
  if (storeRegionName) return storeRegionName;
  const parts = storeAddress.split("-");
  return parts[1] || null;
}

function extractSubarea(storeName: string): string | null {
  const match = storeName.match(/(.+?)(附近|周边|旁边|店)/);
  return match?.[1] ?? null;
}

function extractPositionType(jobName: string): string {
  const parts = jobName.split("-");
  return parts[parts.length - 2] || jobName;
}

function convertWeekdays(dulidayWeekdays: number[]): number[] {
  return dulidayWeekdays.filter((day) => Number.isFinite(day)).map((day) => (day === 0 ? 7 : day));
}
