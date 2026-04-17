import { z } from "zod";

export const REPLY_AUTHORITY_ISSUER = "reply-authority-service";
export const REPLY_AUTHORITY_AUDIENCE = "browser-use-agent/zhipin_send_reply";
export const REPLY_AUTHORITY_PLATFORM = "zhipin";
export const REPLY_AUTHORITY_CLOCK_SKEW_SECONDS = 60;

export const RecruiterBindingSchema = z.object({
  platform: z.literal(REPLY_AUTHORITY_PLATFORM),
  username: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

export const ReplyAuthorityEnvelopePayloadSchema = z.object({
  v: z.literal(2),
  iss: z.literal(REPLY_AUTHORITY_ISSUER),
  kid: z.string().min(1),
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  aud: z.literal(REPLY_AUTHORITY_AUDIENCE),
  platform: z.literal(REPLY_AUTHORITY_PLATFORM),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  candidateId: z.string().min(1),
  reply: z.string(),
  policyVersion: z.string().min(1),
  recruiterBinding: RecruiterBindingSchema,
});

export const ReplyAuthorityPublicKeySchema = z.object({
  kid: z.string().min(1),
  algorithm: z.literal("Ed25519"),
  publicKey: z.string().min(1),
  validFrom: z.string().min(1),
  validUntil: z.string().optional(),
});

export const ReplyAuthorityPublicKeysResponseSchema = z.object({
  keys: z.array(ReplyAuthorityPublicKeySchema),
});

export type ReplyAuthorityEnvelopePayload = z.infer<typeof ReplyAuthorityEnvelopePayloadSchema>;
export type ReplyAuthorityPublicKey = z.infer<typeof ReplyAuthorityPublicKeySchema>;
export type RecruiterBinding = z.infer<typeof RecruiterBindingSchema>;
