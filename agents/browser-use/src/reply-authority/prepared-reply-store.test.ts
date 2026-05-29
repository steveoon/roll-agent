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
