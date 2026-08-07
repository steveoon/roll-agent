import { z } from "zod/v4";
import { isAbsolute } from "node:path";
import { deviceIdSchema, workspaceIdSchema } from "@roll-agent/relay-protocol";
import { COMPANION_CONFIG_VERSION, COMPANION_CONTROL_PROTOCOL_VERSION } from "./constants.ts";

export const credentialReferenceSchema = z
  .string()
  .regex(/^(?:keychain|dpapi):[A-Za-z0-9._-]+$/)
  .brand<"CompanionCredentialReference">();

export type CompanionCredentialReference = z.infer<typeof credentialReferenceSchema>;

export const companionConfigSchema = z
  .object({
    version: z.literal(COMPANION_CONFIG_VERSION),
    deviceId: deviceIdSchema,
    workspaceId: workspaceIdSchema,
    cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute"),
    enabled: z.boolean(),
    credentialRef: credentialReferenceSchema,
  })
  .strict()
  .readonly();

export type CompanionConfig = z.infer<typeof companionConfigSchema>;

export const deviceEnrollmentResultSchema = z
  .object({
    deviceId: deviceIdSchema,
    workspaceId: workspaceIdSchema,
    deviceCredential: z.string().min(16),
  })
  .strict()
  .readonly();

export type DeviceEnrollmentResult = z.infer<typeof deviceEnrollmentResultSchema>;

export const companionHostPhaseSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "recovering",
  "stopping",
]);

export type CompanionHostPhase = z.infer<typeof companionHostPhaseSchema>;

export const companionHostStatusSchema = z
  .object({
    phase: companionHostPhaseSchema,
    enabled: z.boolean(),
    enrolled: z.boolean(),
    runtimeOnline: z.boolean(),
    relayProfile: z.literal("roll-cloud-v1"),
    deviceId: deviceIdSchema.optional(),
    workspaceId: workspaceIdSchema.optional(),
    cwd: z.string().optional(),
    lastError: z.string().optional(),
  })
  .strict()
  .readonly();

export type CompanionHostStatus = z.infer<typeof companionHostStatusSchema>;

export const companionControlRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(COMPANION_CONTROL_PROTOCOL_VERSION),
      type: z.literal("status"),
    })
    .strict(),
  z
    .object({
      version: z.literal(COMPANION_CONTROL_PROTOCOL_VERSION),
      type: z.literal("stop"),
    })
    .strict(),
]);

export type CompanionControlRequest = z.infer<typeof companionControlRequestSchema>;

export const companionControlResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(COMPANION_CONTROL_PROTOCOL_VERSION),
      ok: z.literal(true),
      status: companionHostStatusSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(COMPANION_CONTROL_PROTOCOL_VERSION),
      ok: z.literal(false),
      code: z.enum(["INVALID_REQUEST", "INTERNAL_ERROR"]),
    })
    .strict(),
]);

export type CompanionControlResponse = z.infer<typeof companionControlResponseSchema>;

export const companionDoctorCheckSchema = z
  .object({
    name: z.string().min(1),
    ok: z.boolean(),
    detail: z.string().min(1),
  })
  .strict()
  .readonly();

export const companionDoctorResultSchema = z
  .object({
    ok: z.boolean(),
    checks: z.array(companionDoctorCheckSchema).readonly(),
  })
  .strict()
  .readonly();

export type CompanionDoctorCheck = z.infer<typeof companionDoctorCheckSchema>;
export type CompanionDoctorResult = z.infer<typeof companionDoctorResultSchema>;
