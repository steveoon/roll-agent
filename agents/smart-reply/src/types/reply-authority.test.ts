import assert from "node:assert/strict";
import test from "node:test";
import {
  GenerateReplyToolInputSchema,
  GenerateSignedReplyResponseSchema,
} from "./reply-authority.ts";

const BASE_INPUT = {
  candidateMessage: "你好，请问薪资是多少？",
  target: {
    platform: "zhipin" as const,
    conversationId: "685501091-0",
    candidateId: "candidate-123",
  },
};

test("GenerateReplyToolInputSchema accepts direct recruiter binding mode", () => {
  const parsed = GenerateReplyToolInputSchema.parse({
    ...BASE_INPUT,
    target: {
      ...BASE_INPUT.target,
      tenantId: "tenant-001",
      recruiterBinding: {
        platform: "zhipin",
        username: "recruiter-alice",
      },
    },
  });

  assert.equal(parsed.target.tenantId, "tenant-001");
  assert.equal(parsed.target.recruiterBinding?.username, "recruiter-alice");
});

test("GenerateReplyToolInputSchema accepts proxy mode with recruiterUsername", () => {
  const parsed = GenerateReplyToolInputSchema.parse({
    ...BASE_INPUT,
    target: {
      ...BASE_INPUT.target,
      recruiterUsername: "recruiter-alice",
    },
  });

  assert.equal(parsed.target.recruiterUsername, "recruiter-alice");
  assert.equal(parsed.target.tenantId, undefined);
});

test("GenerateReplyToolInputSchema accepts modelConfig reasoning controls", () => {
  const parsed = GenerateReplyToolInputSchema.parse({
    ...BASE_INPUT,
    modelConfig: {
      reasoning: {
        enabled: true,
        effort: "medium",
        scope: "reply",
      },
    },
    target: {
      ...BASE_INPUT.target,
      recruiterUsername: "recruiter-alice",
    },
  });

  assert.deepEqual(parsed.modelConfig?.reasoning, {
    enabled: true,
    effort: "medium",
    scope: "reply",
  });
});

test("GenerateReplyToolInputSchema accepts locationSignals", () => {
  const parsed = GenerateReplyToolInputSchema.parse({
    ...BASE_INPUT,
    locationSignals: [
      {
        text: "人民广场",
        source: "candidate_message",
        city: "上海",
        intent: "nearby_store",
        confidence: 0.93,
      },
    ],
    target: {
      ...BASE_INPUT.target,
      recruiterUsername: "recruiter-alice",
    },
  });

  assert.deepEqual(parsed.locationSignals, [
    {
      text: "人民广场",
      source: "candidate_message",
      city: "上海",
      intent: "nearby_store",
      confidence: 0.93,
    },
  ]);
});

test("GenerateReplyToolInputSchema rejects targets without recruiter information", () => {
  assert.throws(
    () => GenerateReplyToolInputSchema.parse(BASE_INPUT),
    /target\.recruiterBinding 或 target\.recruiterUsername 至少需要提供一个/,
  );
});

test("GenerateSignedReplyResponseSchema accepts replyVariants passthrough", () => {
  const parsed = GenerateSignedReplyResponseSchema.parse({
    suggestedReply: "你好，薪资可以详聊。",
    signedEnvelope: "payload.draft.signature",
    envelopeExp: 4_102_444_800,
    confidence: 0.9,
    stage: "job_consultation",
    replyPolicySource: "file",
    replyVariants: {
      groupId: "rvg_abc123",
      recommended: "draft",
      items: [
        {
          variant: "draft",
          suggestedReply: "你好，薪资可以详聊。",
          signedEnvelope: "payload.draft.signature",
          envelopeExp: 4_102_444_800,
        },
        {
          variant: "revised",
          suggestedReply: "你好，我可以帮你确认薪资范围。",
          signedEnvelope: "payload.revised.signature",
          envelopeExp: 4_102_444_800,
        },
      ],
      findings: [
        {
          code: "off_axis_fact_disclosure",
          description: "首稿包含候选人未询问的信息。",
        },
      ],
      rubricVersion: "reply-quality-v1",
      rubricHash: "sha256:test",
    },
  });

  assert.equal(parsed.replyVariants?.groupId, "rvg_abc123");
  assert.equal(parsed.replyVariants?.items[1]?.variant, "revised");
});
