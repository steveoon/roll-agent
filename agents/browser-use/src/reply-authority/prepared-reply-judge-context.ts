import {
  CandidateInfoSchema,
  type GenerateReplyToolInput,
} from "@roll-agent/reply-authority-client";
import { z } from "zod";

const MAX_CANDIDATE_MESSAGE_LENGTH = 1_000;
const MAX_CONVERSATION_ITEMS = 8;
const MAX_CONVERSATION_ITEM_LENGTH = 500;
const MAX_PROFILE_VALUE_LENGTH = 200;
const MAX_PROFILE_TAGS = 12;
const MAX_PROFILE_TAG_LENGTH = 100;

const PreparedReplyJudgeCandidateInfoSchema = CandidateInfoSchema.pick({
  age: true,
  experience: true,
  education: true,
  communicationPosition: true,
  expectedPosition: true,
  expectedLocation: true,
  expectedSalary: true,
  info: true,
});

export const PreparedReplyJudgeContextSchema = z.object({
  candidateMessage: z.string().min(1).max(MAX_CANDIDATE_MESSAGE_LENGTH),
  recentConversation: z
    .array(z.string().min(1).max(MAX_CONVERSATION_ITEM_LENGTH))
    .max(MAX_CONVERSATION_ITEMS),
  candidateInfo: PreparedReplyJudgeCandidateInfoSchema.optional(),
  preferredBrand: z.string().min(1).max(MAX_PROFILE_VALUE_LENGTH).optional(),
});

export type PreparedReplyJudgeContext = z.infer<typeof PreparedReplyJudgeContextSchema>;

export function redactPreparedReplyJudgeText(value: string): string {
  return value
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已隐藏]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已隐藏]")
    .replace(
      /(微信|wechat|vx|v信)(?:号|是|[:：]|\s)*[A-Za-z0-9][-_A-Za-z0-9]{5,19}/gi,
      "$1 [账号已隐藏]",
    );
}

function truncate(value: string, maxLength: number): string {
  const normalized = redactPreparedReplyJudgeText(value).replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function compactCandidateInfo(
  candidateInfo: GenerateReplyToolInput["candidateInfo"],
): PreparedReplyJudgeContext["candidateInfo"] {
  if (candidateInfo === undefined) {
    return undefined;
  }

  const compacted = {
    ...(candidateInfo.age !== undefined
      ? { age: truncate(candidateInfo.age, MAX_PROFILE_VALUE_LENGTH) }
      : {}),
    ...(candidateInfo.experience !== undefined
      ? { experience: truncate(candidateInfo.experience, MAX_PROFILE_VALUE_LENGTH) }
      : {}),
    ...(candidateInfo.education !== undefined
      ? { education: truncate(candidateInfo.education, MAX_PROFILE_VALUE_LENGTH) }
      : {}),
    ...(candidateInfo.communicationPosition !== undefined
      ? {
          communicationPosition: truncate(
            candidateInfo.communicationPosition,
            MAX_PROFILE_VALUE_LENGTH,
          ),
        }
      : {}),
    ...(candidateInfo.expectedPosition !== undefined
      ? { expectedPosition: truncate(candidateInfo.expectedPosition, MAX_PROFILE_VALUE_LENGTH) }
      : {}),
    ...(candidateInfo.expectedLocation !== undefined
      ? { expectedLocation: truncate(candidateInfo.expectedLocation, MAX_PROFILE_VALUE_LENGTH) }
      : {}),
    ...(candidateInfo.expectedSalary !== undefined
      ? { expectedSalary: truncate(candidateInfo.expectedSalary, MAX_PROFILE_VALUE_LENGTH) }
      : {}),
    ...(candidateInfo.info !== undefined
      ? {
          info: candidateInfo.info
            .map((item) => truncate(item, MAX_PROFILE_TAG_LENGTH))
            .filter((item) => item.length > 0)
            .slice(0, MAX_PROFILE_TAGS),
        }
      : {}),
  };

  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function buildPreparedReplyJudgeContext(
  input: GenerateReplyToolInput,
): PreparedReplyJudgeContext {
  const candidateMessage = truncate(input.candidateMessage, MAX_CANDIDATE_MESSAGE_LENGTH);
  if (candidateMessage.length === 0) {
    throw new Error("Judge context 缺少候选人当前消息");
  }

  const recentConversation = (input.conversationHistory ?? [])
    .map((item) => truncate(item, MAX_CONVERSATION_ITEM_LENGTH))
    .filter((item) => item.length > 0)
    .slice(-MAX_CONVERSATION_ITEMS);
  const candidateInfo = compactCandidateInfo(input.candidateInfo);
  const preferredBrand =
    input.preferredBrand !== undefined
      ? truncate(input.preferredBrand, MAX_PROFILE_VALUE_LENGTH)
      : undefined;

  return PreparedReplyJudgeContextSchema.parse({
    candidateMessage,
    recentConversation,
    ...(candidateInfo !== undefined ? { candidateInfo } : {}),
    ...(preferredBrand !== undefined && preferredBrand.length > 0 ? { preferredBrand } : {}),
  });
}
