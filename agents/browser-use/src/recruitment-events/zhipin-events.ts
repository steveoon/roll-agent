import type { AgentLogger } from "@roll-agent/sdk";
import type {
  NativeCandidateChatDetails,
  NativeChatMessage,
  NativeRecommendGreetResult,
} from "../pages/zhipin/native-page.ts";
import {
  buildRecruitmentIdempotencyKey,
  recordRecruitmentEventAsync,
  type RecruitmentEventDraft,
  type RecruitmentEventPayload,
} from "./client.ts";

type ZhipinUnreadCandidate = {
  readonly conversationId: string;
  readonly candidateId: string;
  readonly name: string;
  readonly position: string;
  readonly preview: string;
  readonly unreadCount: number;
  readonly hasUnread: boolean;
};

type ZhipinMessageSentInput = {
  readonly conversationId: string;
  readonly candidateId: string;
  readonly replyId: string;
  readonly candidateName: string;
  readonly message: string;
  readonly unreadCountBeforeReply: number;
  readonly candidateDetails?: NativeCandidateChatDetails;
};

type ZhipinWechatRequestedInput = {
  readonly conversationId: string;
  readonly candidateId: string;
  readonly candidateName: string;
  readonly exchangeType?: "requested" | "accepted";
  readonly wechatNumber?: string;
  readonly candidateDetails?: NativeCandidateChatDetails;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function buildCandidateFromDetails(
  details: NativeCandidateChatDetails | undefined,
  fallbackName: string,
  position: string,
): RecruitmentEventPayload["candidate"] {
  const candidate = details?.candidateInfo;
  const age = nonEmpty(candidate?.age);
  const education = nonEmpty(candidate?.education);
  const expectedSalary = nonEmpty(candidate?.expectedSalary);
  return {
    name: nonEmpty(candidate?.name) ?? fallbackName,
    position,
    ...(age !== undefined ? { age } : {}),
    ...(education !== undefined ? { education } : {}),
    ...(expectedSalary !== undefined ? { expectedSalary } : {}),
  };
}

function getCommunicationPosition(details: NativeCandidateChatDetails | undefined): string {
  return nonEmpty(details?.candidateInfo.communicationPosition) ?? "";
}

function getExpectedPosition(details: NativeCandidateChatDetails | undefined): string {
  const expectedJobText = nonEmpty(details?.candidateInfo.expectedJobText);
  if (expectedJobText === undefined) return "";
  const parts = expectedJobText
    .split(/[·|｜]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? (parts[1] ?? "") : expectedJobText;
}

function getExpectedLocation(details: NativeCandidateChatDetails | undefined): string | undefined {
  const expectedJobText = nonEmpty(details?.candidateInfo.expectedJobText);
  if (expectedJobText === undefined) return undefined;
  const parts = expectedJobText
    .split(/[·|｜]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? nonEmpty(parts[0]) : undefined;
}

function withOptionalJob(jobName: string): { readonly job: { readonly jobName: string } } | {} {
  return jobName.length > 0 ? { job: { jobName } } : {};
}

function hasRequiredCandidateIdentity(name: string, position: string): boolean {
  return name.trim().length > 0 && position.trim().length > 0;
}

function extractWechatNumber(message: NativeChatMessage): string | undefined {
  const content = message.content.trim();
  const labeled = /微信(?:号)?\s*[:：]?\s*([A-Za-z0-9_-]{5,})/.exec(content);
  if (labeled?.[1] !== undefined) return labeled[1];
  return /^[A-Za-z][A-Za-z0-9_-]{5,}$/.test(content) ? content : undefined;
}

export function recordZhipinMessageReceivedEvents(
  candidates: ReadonlyArray<ZhipinUnreadCandidate>,
  logger: AgentLogger,
): void {
  for (const candidate of candidates) {
    if (!candidate.hasUnread || candidate.name.length === 0) continue;
    if (!hasRequiredCandidateIdentity(candidate.name, candidate.position)) continue;

    recordRecruitmentEventAsync(
      {
        idempotencyKey: buildRecruitmentIdempotencyKey("zhipin-message-received", [
          candidate.conversationId,
          candidate.candidateId,
          candidate.name,
          candidate.position,
          todayKey(),
        ]),
        sourcePlatform: "zhipin",
        dataSource: "api_callback",
        eventType: "message_received",
        candidate: {
          name: candidate.name,
          position: candidate.position,
        },
        job: {
          jobId: 0,
          jobName: candidate.position,
        },
        details: {
          unreadCount: candidate.unreadCount > 0 ? candidate.unreadCount : 1,
          lastMessagePreview: candidate.preview,
          conversationId: candidate.conversationId,
          candidateId: candidate.candidateId,
        },
      },
      logger,
    );
  }
}

export function recordZhipinMessageSentEvent(
  input: ZhipinMessageSentInput,
  logger: AgentLogger,
): void {
  const communicationPosition = getCommunicationPosition(input.candidateDetails);
  const position = communicationPosition;
  const candidate = buildCandidateFromDetails(
    input.candidateDetails,
    input.candidateName,
    position,
  );
  if (!hasRequiredCandidateIdentity(candidate.name, candidate.position)) return;
  const expectedLocation = getExpectedLocation(input.candidateDetails);

  const event = {
    idempotencyKey: buildRecruitmentIdempotencyKey("zhipin-message-sent", [
      input.conversationId,
      input.candidateId,
      input.replyId,
    ]),
    sourcePlatform: "zhipin",
    dataSource: "api_callback",
    eventType: "message_sent",
    candidate: {
      ...candidate,
      ...(expectedLocation !== undefined ? { expectedLocation } : {}),
    },
    ...withOptionalJob(communicationPosition),
    details: {
      content: input.message,
      isAutoReply: true,
      unreadCountBeforeReply: input.unreadCountBeforeReply,
      wasUnreadBeforeReply: input.unreadCountBeforeReply > 0,
      conversationId: input.conversationId,
      candidateId: input.candidateId,
    },
  } satisfies RecruitmentEventDraft;

  recordRecruitmentEventAsync(event, logger);
}

export function recordZhipinCandidateContactedEvent(
  result: NativeRecommendGreetResult,
  logger: AgentLogger,
): void {
  if (!result.clicked || result.name.length === 0) return;
  const position = nonEmpty(result.expectedPosition);
  if (position === undefined || !hasRequiredCandidateIdentity(result.name, position)) return;
  const age = nonEmpty(result.age);
  const education = nonEmpty(result.education);
  const expectedSalary = nonEmpty(result.expectedSalary);
  const expectedLocation = nonEmpty(result.expectedLocation);

  recordRecruitmentEventAsync(
    {
      idempotencyKey: buildRecruitmentIdempotencyKey("zhipin-candidate-contacted", [
        result.candidateId,
        result.name,
        todayKey(),
      ]),
      sourcePlatform: "zhipin",
      dataSource: "api_callback",
      eventType: "candidate_contacted",
      candidate: {
        name: result.name,
        position,
        ...(age !== undefined ? { age } : {}),
        ...(education !== undefined ? { education } : {}),
        ...(expectedSalary !== undefined ? { expectedSalary } : {}),
        ...(expectedLocation !== undefined ? { expectedLocation } : {}),
      },
      details: {
        candidateId: result.candidateId,
      },
    },
    logger,
  );
}

export function recordZhipinWechatRequestedEvent(
  input: ZhipinWechatRequestedInput,
  logger: AgentLogger,
): void {
  const communicationPosition = getCommunicationPosition(input.candidateDetails);
  const candidate = buildCandidateFromDetails(
    input.candidateDetails,
    input.candidateName,
    communicationPosition,
  );
  if (!hasRequiredCandidateIdentity(candidate.name, candidate.position)) return;
  const expectedLocation = getExpectedLocation(input.candidateDetails);

  recordRecruitmentEventAsync(
    {
      idempotencyKey: buildRecruitmentIdempotencyKey("zhipin-wechat-requested", [
        input.conversationId,
        input.candidateId,
        todayKey(),
      ]),
      sourcePlatform: "zhipin",
      dataSource: "api_callback",
      eventType: "wechat_exchanged",
      candidate: {
        ...candidate,
        ...(expectedLocation !== undefined ? { expectedLocation } : {}),
      },
      ...withOptionalJob(communicationPosition),
      details: {
        exchangeType:
          input.exchangeType ?? (input.wechatNumber !== undefined ? "accepted" : "requested"),
        conversationId: input.conversationId,
        candidateId: input.candidateId,
        ...(input.wechatNumber !== undefined ? { wechatNumber: input.wechatNumber } : {}),
      },
    },
    logger,
  );
}

export function recordZhipinWechatCompletedEvents(
  details: NativeCandidateChatDetails,
  conversationId: string,
  candidateId: string,
  logger: AgentLogger,
): void {
  const communicationPosition = getCommunicationPosition(details);
  const expectedPosition = getExpectedPosition(details);
  const expectedLocation = getExpectedLocation(details);
  const candidate = buildCandidateFromDetails(
    details,
    details.candidateInfo.name,
    expectedPosition,
  );
  if (!hasRequiredCandidateIdentity(candidate.name, candidate.position)) return;
  const firstWechatMessage = details.messages.find(
    (message) => message.messageType === "wechat-exchange",
  );

  if (firstWechatMessage === undefined) return;

  const wechatNumber = extractWechatNumber(firstWechatMessage);
  recordRecruitmentEventAsync(
    {
      idempotencyKey: buildRecruitmentIdempotencyKey("zhipin-wechat-completed", [
        conversationId,
        candidateId,
      ]),
      sourcePlatform: "zhipin",
      dataSource: "api_callback",
      eventType: "wechat_exchanged",
      candidate: {
        ...candidate,
        ...(expectedLocation !== undefined ? { expectedLocation } : {}),
      },
      ...withOptionalJob(communicationPosition),
      details: {
        exchangeType: "completed",
        conversationId,
        candidateId,
        messageIndex: firstWechatMessage.index,
        ...(wechatNumber !== undefined ? { wechatNumber } : {}),
      },
    },
    logger,
  );
}
