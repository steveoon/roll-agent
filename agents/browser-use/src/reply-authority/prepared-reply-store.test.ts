import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  consumePreparedReply,
  inspectPreparedReply,
  resetPreparedReplyStoreForTests,
  savePreparedReply,
} from "./prepared-reply-store.ts";

afterEach(() => {
  resetPreparedReplyStoreForTests();
});

describe("prepared reply store", () => {
  it("saves and consumes a prepared reply once", () => {
    const saved = savePreparedReply(
      {
        signedEnvelope: "payload.signature",
        suggestedReply: "你好",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 200,
      },
      100,
    );

    assert.match(saved.preparedReplyId, /^prep_/);

    const first = consumePreparedReply(saved.preparedReplyId, 120);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.record.signedEnvelope, "payload.signature");
    }

    const second = consumePreparedReply(saved.preparedReplyId, 121);
    assert.deepEqual(second, { ok: false, reason: "consumed" });
  });

  it("inspects a prepared reply without consuming it", () => {
    const saved = savePreparedReply(
      {
        signedEnvelope: "payload.signature",
        suggestedReply: "你好",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 200,
      },
      100,
    );

    const inspected = inspectPreparedReply(saved.preparedReplyId, 120);
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.record.signedEnvelope, "payload.signature");
    }

    assert.equal(consumePreparedReply(saved.preparedReplyId, 121).ok, true);
  });

  it("preserves unread context across save, inspect, and consume", () => {
    const saved = savePreparedReply(
      {
        signedEnvelope: "payload.signature",
        suggestedReply: "你好",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 200,
        unreadCountBeforeReply: 2,
      },
      100,
    );

    assert.equal(saved.unreadCountBeforeReply, 2);

    const inspected = inspectPreparedReply(saved.preparedReplyId, 120);
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.record.unreadCountBeforeReply, 2);
    }

    const consumed = consumePreparedReply(saved.preparedReplyId, 121);
    assert.equal(consumed.ok, true);
    if (consumed.ok) {
      assert.equal(consumed.record.unreadCountBeforeReply, 2);
    }
  });

  it("stores dual-draft variant groups and consumes them at group level", () => {
    const saved = savePreparedReply(
      {
        signedEnvelope: "payload.draft.signature",
        suggestedReply: "你好，薪资可以详聊。",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 200,
        variantGroup: {
          groupId: "rvg_abc123",
          options: [
            {
              option: "option_1",
              variant: "revised",
              suggestedReply: "你好，我帮你确认薪资范围。",
              signedEnvelope: "payload.revised.signature",
              envelopeExp: 200,
            },
            {
              option: "option_2",
              variant: "draft",
              suggestedReply: "你好，薪资可以详聊。",
              signedEnvelope: "payload.draft.signature",
              envelopeExp: 200,
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
          target: {
            platform: "zhipin",
            tenantId: "tenant-001",
            conversationId: "conv-1",
          },
          recommendedOption: "option_2",
        },
      },
      100,
    );

    const inspected = inspectPreparedReply(saved.preparedReplyId, 120);
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.record.variantGroup?.groupId, "rvg_abc123");
      assert.equal(inspected.record.variantGroup?.options[0]?.variant, "revised");
    }

    const first = consumePreparedReply(saved.preparedReplyId, 121);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.record.variantGroup?.recommendedOption, "option_2");
    }

    assert.deepEqual(consumePreparedReply(saved.preparedReplyId, 122), {
      ok: false,
      reason: "consumed",
    });
  });

  it("expires stale prepared replies", () => {
    const saved = savePreparedReply(
      {
        signedEnvelope: "payload.signature",
        suggestedReply: "你好",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 120,
      },
      100,
    );

    assert.deepEqual(consumePreparedReply(saved.preparedReplyId, 120), {
      ok: false,
      reason: "expired",
    });
  });

  it("rejects already expired prepared replies on save", () => {
    assert.throws(
      () =>
        savePreparedReply(
          {
            signedEnvelope: "payload.signature",
            suggestedReply: "你好",
            stage: "job_consultation",
            confidence: 0.9,
            expiresAt: 100,
          },
          100,
        ),
      /已过期/,
    );
  });
});
