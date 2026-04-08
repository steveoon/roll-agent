import { z } from "zod";

// ========== Duliday 新 API 响应 Zod Schema ==========

export const DulidayMoreWelfareItemSchema = z
  .object({
    content: z.string(),
    image: z.string().nullable().optional(),
  })
  .passthrough();

export const DulidayStoreInfoSchema = z
  .object({
    storeId: z.number().optional(),
    storeName: z.string(),
    storeCityName: z.string().optional(),
    storeRegionName: z.string().optional(),
    storeAddress: z.string().optional(),
    longitude: z.number().optional(),
    latitude: z.number().optional(),
  })
  .passthrough();

export const DulidayBasicInfoSchema = z
  .object({
    jobId: z.number(),
    jobName: z.string(),
    jobNickName: z.string().nullable().optional(),
    jobCategoryName: z.string().nullable().optional(),
    jobContent: z.string().nullable().optional(),
    laborForm: z.string().nullable().optional(),
    needTraining: z.string().nullable().optional(),
    needProbationWork: z.string().nullable().optional(),
    brandId: z.number().optional(),
    brandName: z.string().optional(),
    projectId: z.number().optional(),
    projectName: z.string().optional(),
    storeInfo: DulidayStoreInfoSchema.optional(),
  })
  .passthrough();

export const DulidaySalaryScenarioSchema = z
  .object({
    salaryType: z.string().nullable().optional(),
    salaryPeriod: z.string().nullable().optional(),
    hasStairSalary: z.string().nullable().optional(),
    basicSalary: z
      .object({
        basicSalary: z.number().nullable().optional(),
        basicSalaryUnit: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    stairSalaries: z
      .array(
        z
          .object({
            fullWorkTime: z.number().nullable().optional(),
            fullWorkTimeUnit: z.string().nullable().optional(),
            salary: z.number().nullable().optional(),
            salaryUnit: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    comprehensiveSalary: z
      .object({
        minComprehensiveSalary: z.number().nullable().optional(),
        maxComprehensiveSalary: z.number().nullable().optional(),
        comprehensiveSalaryUnit: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    holidaySalary: z
      .object({
        holidaySalaryType: z.string().nullable().optional(),
        holidaySalaryMultiple: z.number().nullable().optional(),
        holidayFixedSalary: z.number().nullable().optional(),
        holidayFixedSalaryUnit: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const DulidayJobSalarySchema = z
  .object({
    salary: z.number().optional(),
    salaryUnitStr: z.string().optional(),
    salaryScenarioList: z.array(DulidaySalaryScenarioSchema).nullable().optional(),
  })
  .passthrough();

export const DulidayNewWelfareSchema = z
  .object({
    haveInsurance: z.string(),
    accommodation: z.string(),
    catering: z.string().optional(),
    otherWelfare: z.array(z.string()).nullable().optional(),
    accommodationAllowance: z.number().nullable().optional(),
    accommodationAllowanceUnit: z.string().nullable().optional(),
    cateringSalary: z.number().nullable().optional(),
    cateringSalaryUnit: z.string().nullable().optional(),
    trafficAllowanceSalary: z.number().nullable().optional(),
    trafficAllowanceSalaryUnit: z.string().nullable().optional(),
    memo: z.string().nullable().optional(),
    promotionWelfare: z.string().nullable().optional(),
    moreWelfares: z.array(DulidayMoreWelfareItemSchema).nullable().optional(),
  })
  .passthrough();

export const DulidayBasicPersonalRequirementsSchema = z
  .object({
    minAge: z.number().nullable().optional(),
    maxAge: z.number().nullable().optional(),
    genderRequirement: z.string().nullable().optional(),
  })
  .passthrough();

export const DulidayCertificateSchema = z
  .object({
    education: z.string().nullable().optional(),
    healthCertificate: z.string().nullable().optional(),
    certificates: z.string().nullable().optional(),
  })
  .passthrough();

export const DulidayLanguageSchema = z
  .object({
    languages: z.string().nullable().optional(),
    languageRemark: z.string().nullable().optional(),
  })
  .passthrough();

export const DulidayHiringRequirementSchema = z
  .object({
    cooperationMode: z.number().optional(),
    requirementNum: z.number().optional(),
    thresholdNum: z.number().optional(),
    signUpNum: z.number().nullable().optional(),
    basicPersonalRequirements: DulidayBasicPersonalRequirementsSchema.nullable().optional(),
    certificate: DulidayCertificateSchema.nullable().optional(),
    language: DulidayLanguageSchema.nullable().optional(),
    figure: z.string().nullable().optional(),
    remark: z.string().nullable().optional(),
  })
  .passthrough();

export const DulidayNewWorkTimeSchema = z
  .object({
    employmentForm: z.string(),
    minWorkMonths: z.number().nullable().optional(),
    maxWorkTakingTime: z.number().nullable().optional(),
    restTimeDesc: z.string().nullable().optional(),
    workTimeRemark: z.string().nullable().optional(),
    employmentDescription: z.string().nullable().optional(),
    weekWorkTime: z
      .object({
        weekWorkTimeRequirement: z.string().nullable().optional(),
        perWeekWorkDays: z.number().nullable().optional(),
        perWeekRestDays: z.number().nullable().optional(),
        perWeekNeedWorkDays: z.union([z.string(), z.number()]).nullable().optional(),
        workSingleDouble: z.string().nullable().optional(),
        customnWorkTimeList: z
          .array(
            z
              .object({
                customMinWorkDays: z.number().nullable().optional(),
                customMaxWorkDays: z.number().nullable().optional(),
                customWorkWeekdays: z
                  .array(z.union([z.string(), z.number()]))
                  .nullable()
                  .optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    monthWorkTime: z
      .object({
        perMonthMinWorkTime: z.number().nullable().optional(),
        perMonthMinWorkTimeUnit: z.union([z.string(), z.number()]).nullable().optional(),
        monthWorkTimeRequirement: z.string().nullable().optional(),
        perMonthMaxRestTime: z.number().nullable().optional(),
        perMonthMaxRestTimeUnit: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    dayWorkTime: z
      .object({
        perDayMinWorkHours: z.union([z.string(), z.number()]).nullable().optional(),
        dayWorkTimeRequirement: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    dailyShiftSchedule: z
      .object({
        arrangementType: z.string().nullable().optional(),
        fixedScheduleList: z
          .array(
            z
              .object({
                fixedShiftStartTime: z.union([z.string(), z.number()]).optional(),
                fixedShiftEndTime: z.union([z.string(), z.number()]).optional(),
                startTime: z.number().optional(),
                endTime: z.number().optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
        combinedArrangement: z
          .array(
            z
              .object({
                CombinedArrangementWeekdays: z.union([z.string(), z.array(z.number())]).optional(),
                CombinedArrangementStartTime: z.number().optional(),
                CombinedArrangementEndTime: z.number().optional(),
                combinedArrangementStartTime: z.union([z.string(), z.number()]).optional(),
                combinedArrangementEndTime: z.union([z.string(), z.number()]).optional(),
                startTime: z.number().optional(),
                endTime: z.number().optional(),
                weekdays: z.array(z.number()).optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
        fixedTime: z
          .object({
            goToWorkStartTime: z.union([z.string(), z.number()]).nullable().optional(),
            goToWorkEndTime: z.union([z.string(), z.number()]).nullable().optional(),
            goOffWorkStartTime: z.union([z.string(), z.number()]).nullable().optional(),
            goOffWorkEndTime: z.union([z.string(), z.number()]).nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    temporaryEmployment: z
      .object({
        temporaryEmploymentStartTime: z.string().nullable().optional(),
        temporaryEmploymentEndTime: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const DulidayNewPositionSchema = z
  .object({
    basicInfo: DulidayBasicInfoSchema,
    jobSalary: DulidayJobSalarySchema,
    welfare: DulidayNewWelfareSchema,
    hiringRequirement: DulidayHiringRequirementSchema,
    workTime: DulidayNewWorkTimeSchema,
  })
  .passthrough();

// ========== 类型导出 ==========

export type DulidayMoreWelfareItem = z.infer<typeof DulidayMoreWelfareItemSchema>;
export type DulidayStoreInfo = z.infer<typeof DulidayStoreInfoSchema>;
export type DulidayBasicInfo = z.infer<typeof DulidayBasicInfoSchema>;
export type DulidaySalaryScenario = z.infer<typeof DulidaySalaryScenarioSchema>;
export type DulidayJobSalary = z.infer<typeof DulidayJobSalarySchema>;
export type DulidayNewWelfare = z.infer<typeof DulidayNewWelfareSchema>;
export type DulidayBasicPersonalRequirements = z.infer<
  typeof DulidayBasicPersonalRequirementsSchema
>;
export type DulidayCertificate = z.infer<typeof DulidayCertificateSchema>;
export type DulidayHiringRequirement = z.infer<typeof DulidayHiringRequirementSchema>;
export type DulidayNewWorkTime = z.infer<typeof DulidayNewWorkTimeSchema>;
export type DulidayNewPosition = z.infer<typeof DulidayNewPositionSchema>;
