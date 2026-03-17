import { z } from "zod";
import { CoordinatesSchema } from "./geocoding.ts";

// ========== 候选人信息 Schema（内联自 lib/tools/zhipin/types.ts）==========

export const CandidateInfoSchema = z.object({
  name: z.string().optional(),
  position: z.string().optional(),
  expectedPosition: z.string().optional(),
  communicationPosition: z.string().optional(),
  age: z.string().optional(),
  gender: z.string().optional(),
  experience: z.string().optional(),
  education: z.string().optional(),
  expectedSalary: z.string().optional(),
  expectedLocation: z.string().optional(),
  jobAddress: z.string().optional(),
  height: z.string().optional(),
  weight: z.string().optional(),
  healthCertificate: z.boolean().optional(),
  activeTime: z.string().optional(),
  info: z.array(z.string()).optional(),
  fullText: z.string().optional(),
});

export type CandidateInfo = z.infer<typeof CandidateInfoSchema>;

// ========== 薪资与福利 ==========

export const SalaryDetailsSchema = z.object({
  base: z.number(),
  range: z.string().optional(),
  bonus: z.string().optional(),
  memo: z.string(),
  scenarioSummary: z.string().optional(),
  settlementCycle: z.string().optional(),
});

export const BenefitsSchema = z.object({
  items: z.array(z.string()),
  promotion: z.string().optional(),
});

// ========== 出勤/排班 ==========

export const AttendanceRequirementSchema = z.object({
  requiredDays: z.array(z.number().min(1).max(7)).optional(),
  minimumDays: z.number().min(0).optional(),
  description: z.string(),
});

export const ScheduleTypeSchema = z.enum(["fixed", "flexible", "rotating", "on_call"]);

export const AttendancePolicySchema = z.object({
  punctualityRequired: z.boolean(),
  lateToleranceMinutes: z.number().min(0),
  attendanceTracking: z.enum(["strict", "flexible", "none"]),
  makeupShiftsAllowed: z.boolean(),
});

export const TimeSlotAvailabilitySchema = z.object({
  slot: z.string(),
  maxCapacity: z.number().min(0),
  currentBooked: z.number().min(0),
  isAvailable: z.boolean(),
  priority: z.enum(["high", "medium", "low"]),
});

export const SchedulingFlexibilitySchema = z.object({
  canSwapShifts: z.boolean(),
  advanceNoticeHours: z.number().min(0),
  partTimeAllowed: z.boolean(),
  weekendRequired: z.boolean(),
  holidayRequired: z.boolean(),
});

// ========== 招聘要求 ==========

export const HiringRequirementsSchema = z.object({
  minAge: z.number().nullable().optional(),
  maxAge: z.number().nullable().optional(),
  genderRequirement: z.string().nullable().optional(),
  education: z.string().nullable().optional(),
  healthCertificate: z.string().nullable().optional(),
});

export type HiringRequirements = z.infer<typeof HiringRequirementsSchema>;

// ========== 岗位 ==========

export const PositionSchema = z.object({
  id: z.string(),
  name: z.string(),
  brandId: z.string().optional(),
  brandName: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  timeSlots: z.array(z.string()),
  salary: SalaryDetailsSchema,
  workHours: z.string(),
  benefits: BenefitsSchema,
  requirements: z.array(z.string()),
  urgent: z.boolean(),
  scheduleType: ScheduleTypeSchema,
  attendancePolicy: AttendancePolicySchema,
  availableSlots: z.array(TimeSlotAvailabilitySchema),
  schedulingFlexibility: SchedulingFlexibilitySchema,
  minHoursPerWeek: z.number().min(0).optional(),
  maxHoursPerWeek: z.number().min(0).optional(),
  attendanceRequirement: AttendanceRequirementSchema.optional(),
  hiringRequirements: HiringRequirementsSchema.optional(),
  description: z.string().optional(),
});

// ========== 门店 ==========

export const StoreSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  name: z.string(),
  city: z.string().optional(),
  location: z.string(),
  district: z.string(),
  subarea: z.string(),
  coordinates: CoordinatesSchema,
  positions: z.array(PositionSchema),
});

// ========== 品牌与数据 ==========

export const BrandDatasetMetaSchema = z.object({
  defaultBrandId: z.string().optional(),
  syncedAt: z.string().optional(),
  source: z.string().optional(),
});

export const BrandSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  stores: z.array(StoreSchema),
});

export const ZhipinDataSchema = z.object({
  meta: BrandDatasetMetaSchema,
  brands: z.array(BrandSchema),
});

// ========== 类型导出 ==========

export type SalaryDetails = z.infer<typeof SalaryDetailsSchema>;
export type Benefits = z.infer<typeof BenefitsSchema>;
export type AttendanceRequirement = z.infer<typeof AttendanceRequirementSchema>;
export type ScheduleType = z.infer<typeof ScheduleTypeSchema>;
export type AttendancePolicy = z.infer<typeof AttendancePolicySchema>;
export type TimeSlotAvailability = z.infer<typeof TimeSlotAvailabilitySchema>;
export type SchedulingFlexibility = z.infer<typeof SchedulingFlexibilitySchema>;
export type Position = z.infer<typeof PositionSchema>;
export type Store = z.infer<typeof StoreSchema>;
export type BrandDatasetMeta = z.infer<typeof BrandDatasetMetaSchema>;
export type Brand = z.infer<typeof BrandSchema>;
export type ZhipinData = z.infer<typeof ZhipinDataSchema>;
