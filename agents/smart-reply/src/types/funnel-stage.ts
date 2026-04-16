import { z } from "zod";

export const FunnelStageValues = [
  "trust_building",
  "private_channel",
  "qualify_candidate",
  "job_consultation",
  "interview_scheduling",
  "onboard_followup",
] as const;

export const FunnelStageSchema = z.enum(FunnelStageValues);

export type FunnelStage = z.infer<typeof FunnelStageSchema>;
