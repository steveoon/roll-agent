import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPreparedReplyJudgeContext,
  redactPreparedReplyJudgeText,
} from "./prepared-reply-judge-context.ts";

describe("buildPreparedReplyJudgeContext", () => {
  it("keeps only bounded non-identifying context used by reply generation", () => {
    const context = buildPreparedReplyJudgeContext({
      candidateMessage: ` 请问排班时间？${"很".repeat(1_100)} `,
      conversationHistory: [
        "求职者: 手机 13812345678，微信 abc12345，邮箱 test@example.com",
        ...Array.from(
          { length: 9 },
          (_, index) => `求职者: 第${String(index + 2)}条${"问".repeat(600)}`,
        ),
      ],
      candidateInfo: {
        name: "不应保存的姓名",
        age: "25岁",
        experience: "3年餐饮经验",
        communicationPosition: "服务员",
        expectedSalary: "6000元",
        info: Array.from({ length: 20 }, (_, index) => `标签${String(index + 1)}`),
        fullText: "不应保存的完整简历",
      },
      preferredBrand: "测试品牌",
      target: {
        platform: "zhipin",
        conversationId: "conv-secret",
        candidateId: "candidate-secret",
        recruiterUsername: "recruiter-secret",
      },
    });

    assert.equal(context.candidateMessage.length, 1_000);
    assert.equal(context.recentConversation.length, 8);
    assert.equal(context.recentConversation[0]?.startsWith("求职者: 第3条"), true);
    assert.equal(
      context.recentConversation.every((item) => item.length <= 500),
      true,
    );
    assert.equal(context.candidateInfo?.age, "25岁");
    assert.equal(context.candidateInfo?.info?.length, 12);
    assert.equal(context.preferredBrand, "测试品牌");

    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes("不应保存的姓名"), false);
    assert.equal(serialized.includes("不应保存的完整简历"), false);
    assert.equal(serialized.includes("conv-secret"), false);
    assert.equal(serialized.includes("candidate-secret"), false);
    assert.equal(serialized.includes("recruiter-secret"), false);
    assert.equal(serialized.includes("13812345678"), false);
    assert.equal(serialized.includes("abc12345"), false);
    assert.equal(serialized.includes("test@example.com"), false);
  });

  it("rejects an empty candidate message instead of judging without a current goal", () => {
    assert.throws(
      () =>
        buildPreparedReplyJudgeContext({
          candidateMessage: "   ",
          target: {
            platform: "zhipin",
            conversationId: "conv-1",
            candidateId: "candidate-1",
            recruiterUsername: "recruiter-1",
          },
        }),
      /缺少候选人当前消息/,
    );
  });

  it("redacts numeric WeChat IDs without hiding unrelated numeric context", () => {
    const redacted = redactPreparedReplyJudgeText(
      "薪资 6000，验证码 123456；微信号 123456，WeChat: 1abcde，vx 9_test；手机号 13812345678，邮箱 test@example.com",
    );

    assert.equal(
      redacted,
      "薪资 6000，验证码 123456；微信 [账号已隐藏]，WeChat [账号已隐藏]，vx [账号已隐藏]；手机号 [手机号已隐藏]，邮箱 [邮箱已隐藏]",
    );
  });
});
