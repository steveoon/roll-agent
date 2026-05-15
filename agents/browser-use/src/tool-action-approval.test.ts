import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  approveToolAction,
  createToolActionApprovalRequest,
  resetToolActionApprovalsForTests,
} from "./tool-action-approval.ts";

describe("tool action approval", () => {
  afterEach(() => {
    resetToolActionApprovalsForTests();
  });

  it("approves only one matching tool action subject before expiry", () => {
    const subject = {
      tool: "zhipin_send_prepared_reply",
      target: "prep_1",
      summary: "发送预备回复: 你好",
      digest: "sha256:abc",
    };
    const request = createToolActionApprovalRequest(subject, 1_000);

    assert.equal(
      approveToolAction({
        approval: { id: request.id },
        subject,
      }),
      true,
    );
    assert.equal(
      approveToolAction({
        approval: { id: request.id },
        subject,
      }),
      false,
    );
  });

  it("rejects mismatched and expired tool action approvals", () => {
    const subject = {
      tool: "zhipin_send_prepared_reply",
      target: "prep_1",
      digest: "sha256:abc",
    };
    const mismatchRequest = createToolActionApprovalRequest(subject, 1_000);

    assert.equal(
      approveToolAction({
        approval: { id: mismatchRequest.id },
        subject: { ...subject, digest: "sha256:def" },
      }),
      false,
    );
    assert.equal(
      approveToolAction({
        approval: { id: "missing" },
        subject,
      }),
      false,
    );

    const expiredRequest = createToolActionApprovalRequest(subject, 1, 1);
    assert.equal(
      approveToolAction({
        approval: { id: expiredRequest.id },
        subject,
      }),
      false,
    );
  });
});
