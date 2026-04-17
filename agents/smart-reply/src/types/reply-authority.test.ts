import assert from "node:assert/strict";
import test from "node:test";
import { GenerateReplyToolInputSchema } from "./reply-authority.ts";

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

test("GenerateReplyToolInputSchema rejects targets without recruiter information", () => {
  assert.throws(
    () => GenerateReplyToolInputSchema.parse(BASE_INPUT),
    /target\.recruiterBinding 或 target\.recruiterUsername 至少需要提供一个/,
  );
});
