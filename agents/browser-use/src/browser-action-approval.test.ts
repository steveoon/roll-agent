import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  approveBrowserAction,
  createBrowserActionApprovalRequest,
  resetBrowserActionApprovalsForTests,
} from "./browser-action-approval.ts";

describe("browser action approval", () => {
  afterEach(() => {
    resetBrowserActionApprovalsForTests();
  });

  it("approves only matching action details before expiry", () => {
    const request = createBrowserActionApprovalRequest({
      action: "navigate",
      target: "https://www.zhipin.com",
      reason: "action_policy_confirm",
      policy: "confirm",
      url: "https://www.zhipin.com",
    });

    assert.equal(
      approveBrowserAction({
        approval: { id: request.id },
        details: {
          action: "navigate",
          target: "https://www.zhipin.com",
          reason: "action_policy_confirm",
          policy: "confirm",
          url: "https://www.zhipin.com",
        },
      }),
      true,
    );
    assert.equal(
      approveBrowserAction({
        approval: { id: request.id },
        details: {
          action: "navigate",
          target: "https://www.zhipin.com",
          reason: "action_policy_confirm",
          policy: "confirm",
          url: "https://www.zhipin.com",
        },
      }),
      false,
    );
    assert.equal(
      approveBrowserAction({
        approval: { id: request.id },
        details: {
          action: "navigate",
          target: "https://evilzhipin.com",
          reason: "action_policy_confirm",
          policy: "confirm",
          url: "https://evilzhipin.com",
        },
      }),
      false,
    );
    assert.equal(
      approveBrowserAction({
        approval: { id: "missing" },
        details: {
          action: "navigate",
          target: "https://www.zhipin.com",
          reason: "action_policy_confirm",
          policy: "confirm",
          url: "https://www.zhipin.com",
        },
      }),
      false,
    );
  });
});
