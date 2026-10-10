import { z } from "zod/v4";

export const chatGptAccountSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  email: z.string().optional(),
  connected: z.boolean(),
  authorized: z.boolean(),
  expiresAt: z.number().optional(),
  earliestRefreshAt: z.number().optional(),
});
export const chatGptStatusSchema = z.object({
  currentAccountId: z.string().uuid().optional(),
  accounts: z.array(chatGptAccountSchema),
  usageUrl: z.string().url(),
});
export const chatGptModelSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
});
export const chatGptLoginStates = [
  "waiting",
  "exchanging",
  "succeeded",
  "cancelled",
  "denied",
  "failed",
  "timed-out",
] as const;
export const chatGptLoginProgressSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(chatGptLoginStates),
  accountId: z.string().uuid().optional(),
  message: z.string().optional(),
});
export const chatGptRefreshResultSchema = z.object({
  accountId: z.string().uuid(),
  refreshed: z.boolean(),
  earliestRefreshAt: z.number().optional(),
});
export const chatGptLogoutResultSchema = z.object({
  accountId: z.string().uuid(),
  revocationConfirmed: z.boolean(),
});
export type ChatGptStatus = z.infer<typeof chatGptStatusSchema>;
export type ChatGptModel = z.infer<typeof chatGptModelSchema>;
export type ChatGptLoginProgress = z.infer<typeof chatGptLoginProgressSchema>;
export type ChatGptRefreshResult = z.infer<typeof chatGptRefreshResultSchema>;
export type ChatGptLogoutResult = z.infer<typeof chatGptLogoutResultSchema>;

export const credentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  earliestRefreshAt: z.number().optional(),
  savedAt: z.number(),
});
export const registrationSchema = z.object({
  id: z.string().uuid(),
  clientId: z
    .string()
    .min(1)
    .refine((id) => id !== "dynamic_agent_client"),
  hostId: z.string().min(1),
  subject: z.string().optional(),
  email: z.string().optional(),
  credentials: credentialSchema.optional(),
});
export type ChatGptRegistration = z.infer<typeof registrationSchema>;
export type ChatGptCredential = z.infer<typeof credentialSchema>;
