import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@roll-agent/browser";
import {
  getCurrentZhipinRecruiterIdentity,
  matchesRecruiterBinding,
} from "./recruiter-identity.ts";

test("getCurrentZhipinRecruiterIdentity returns the resolved username", async () => {
  const identity = await getCurrentZhipinRecruiterIdentity({} as Page, async () => [
    {
      text: "任思文",
      strategy: "role-link",
      priority: 1,
      source: "role:link",
    },
  ]);

  assert.deepEqual(identity, {
    platform: "zhipin",
    username: "任思文",
    strategy: "role-link",
    source: "role:link",
  });
});

test("getCurrentZhipinRecruiterIdentity throws when no plausible username is found", async () => {
  await assert.rejects(
    async () => await getCurrentZhipinRecruiterIdentity({} as Page, async () => []),
    /未找到用户名，请确认当前页面已登录招聘者账号/,
  );
});

test("matchesRecruiterBinding compares username when accountId is absent", () => {
  assert.equal(
    matchesRecruiterBinding(
      { username: "recruiter-alice" },
      { platform: "zhipin", username: "recruiter-alice" },
    ),
    true,
  );
});

test("matchesRecruiterBinding compares accountId when the envelope requires it", () => {
  assert.equal(
    matchesRecruiterBinding(
      { username: "recruiter-alice" },
      { platform: "zhipin", username: "recruiter-alice", accountId: "acc-1" },
    ),
    false,
  );
});
