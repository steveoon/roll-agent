import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContextManager, Page } from "@roll-agent/browser";
import {
  isPlausibleUsername,
  parseAccessibleNames,
  scoreUsernameEvidence,
  pickBestUsername,
  selectExistingZhipinPage,
  ZHIPIN_USERNAME_LENGTH_LIMIT,
} from "./username.ts";
import type { UsernameEvidence } from "./username.ts";

// ---------------------------------------------------------------------------
// isPlausibleUsername
// ---------------------------------------------------------------------------

test("isPlausibleUsername accepts a typical Chinese name", () => {
  assert.equal(isPlausibleUsername("任思文"), true);
});

test("isPlausibleUsername accepts a name at exactly the length limit", () => {
  assert.equal(isPlausibleUsername("x".repeat(ZHIPIN_USERNAME_LENGTH_LIMIT)), true);
});

test("isPlausibleUsername rejects empty string", () => {
  assert.equal(isPlausibleUsername(""), false);
});

test("isPlausibleUsername rejects whitespace-only string", () => {
  assert.equal(isPlausibleUsername("   "), false);
});

test("isPlausibleUsername rejects overlong string", () => {
  assert.equal(isPlausibleUsername("x".repeat(ZHIPIN_USERNAME_LENGTH_LIMIT + 1)), false);
});

test("isPlausibleUsername rejects known nav label '招聘规范'", () => {
  assert.equal(isPlausibleUsername("招聘规范"), false);
});

test("isPlausibleUsername rejects '登录'", () => {
  assert.equal(isPlausibleUsername("登录"), false);
});

test("isPlausibleUsername rejects '退出登录'", () => {
  assert.equal(isPlausibleUsername("退出登录"), false);
});

test("isPlausibleUsername does not falsely reject short names like 'HR'", () => {
  assert.equal(isPlausibleUsername("HR"), true);
});

test("isPlausibleUsername does not falsely reject 2-char Chinese name", () => {
  assert.equal(isPlausibleUsername("张三"), true);
});

// ---------------------------------------------------------------------------
// parseAccessibleNames
// ---------------------------------------------------------------------------

test("parseAccessibleNames parses link with quoted name", () => {
  assert.deepEqual(parseAccessibleNames('link "任思文"'), [{ role: "link", name: "任思文" }]);
});

test("parseAccessibleNames parses multiple entries", () => {
  const snapshot = `
    link "首页"
    link "消息"
    button "退出"
    link "任思文"
  `;
  const result = parseAccessibleNames(snapshot);
  assert.equal(result.length, 4);
  assert.deepEqual(result[3], { role: "link", name: "任思文" });
});

test("parseAccessibleNames returns empty array for snapshot with no names", () => {
  assert.deepEqual(parseAccessibleNames("some plain text without patterns"), []);
});

test("parseAccessibleNames handles menuitem and button roles", () => {
  const snapshot = 'menuitem "设置" button "任思文"';
  const result = parseAccessibleNames(snapshot);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { role: "menuitem", name: "设置" });
  assert.deepEqual(result[1], { role: "button", name: "任思文" });
});

test("parseAccessibleNames ignores text role (not in pattern)", () => {
  assert.deepEqual(parseAccessibleNames('text "some text"'), []);
});

// ---------------------------------------------------------------------------
// scoreUsernameEvidence
// ---------------------------------------------------------------------------

test("scoreUsernameEvidence: P1 role-based scores lower than P4 CSS", () => {
  const p1: UsernameEvidence = {
    text: "任思文",
    strategy: "role-link",
    priority: 1,
    source: "role:link",
  };
  const p4: UsernameEvidence = {
    text: "任思文",
    strategy: "css-fallback",
    priority: 4,
    source: ".user-name",
  };
  assert.ok(scoreUsernameEvidence(p1) < scoreUsernameEvidence(p4));
});

test("scoreUsernameEvidence: nav label gets heavy penalty", () => {
  const navLabel: UsernameEvidence = {
    text: "招聘规范",
    strategy: "role-link",
    priority: 1,
    source: "role:link",
  };
  const username: UsernameEvidence = {
    text: "任思文",
    strategy: "role-link",
    priority: 1,
    source: "role:link",
  };
  assert.ok(scoreUsernameEvidence(navLabel) > scoreUsernameEvidence(username));
});

test("scoreUsernameEvidence: CJK name gets bonus", () => {
  const cjk: UsernameEvidence = {
    text: "任思文",
    strategy: "role-link",
    priority: 1,
    source: "role:link",
  };
  const ascii: UsernameEvidence = {
    text: "Boss",
    strategy: "role-link",
    priority: 1,
    source: "role:link",
  };
  assert.ok(scoreUsernameEvidence(cjk) < scoreUsernameEvidence(ascii));
});

// ---------------------------------------------------------------------------
// pickBestUsername
// ---------------------------------------------------------------------------

test("pickBestUsername selects best-scored candidate from mixed evidence", () => {
  const evidence: UsernameEvidence[] = [
    { text: "招聘规范", strategy: "css-fallback", priority: 4, source: "#header .label-name" },
    { text: "任思文", strategy: "role-link", priority: 1, source: "role:link" },
    { text: "消息", strategy: "role-link", priority: 1, source: "role:link" },
  ];
  const result = pickBestUsername(evidence);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.username, "任思文");
    assert.equal(result.strategy, "role-link");
  }
});

test("pickBestUsername returns found=false when all candidates are invalid", () => {
  const evidence: UsernameEvidence[] = [
    { text: "招聘规范", strategy: "role-link", priority: 1, source: "role:link" },
    { text: "登录", strategy: "role-button", priority: 1, source: "role:button" },
    { text: "", strategy: "css-fallback", priority: 4, source: ".user-name" },
  ];
  assert.deepEqual(pickBestUsername(evidence), { found: false });
});

test("pickBestUsername: original bug scenario — '招聘规范' vs '任思文'", () => {
  // This is the exact bug that triggered this refactoring:
  // #header .label-name matched "招聘规范" (nav tab) instead of "任思文" (username)
  const evidence: UsernameEvidence[] = [
    { text: "招聘规范", strategy: "css-fallback", priority: 4, source: "#header .label-name" },
    { text: "任思文", strategy: "role-link", priority: 1, source: "role:link" },
  ];
  const result = pickBestUsername(evidence);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.username, "任思文");
  }
});

test("pickBestUsername: cross-confirmation boosts same text from different strategies", () => {
  const evidence: UsernameEvidence[] = [
    { text: "任思文", strategy: "role-link", priority: 1, source: "role:link" },
    { text: "任思文", strategy: "aria-snapshot", priority: 2, source: "aria:link:任思文" },
    { text: "张三", strategy: "role-link", priority: 1, source: "role:link" },
  ];
  const result = pickBestUsername(evidence);
  assert.equal(result.found, true);
  if (result.found) {
    // "任思文" appears in 2 distinct strategies → cross-confirmation bonus → wins
    assert.equal(result.username, "任思文");
  }
});

test("pickBestUsername: same-strategy duplicates do NOT trigger cross-confirmation", () => {
  // Codex found: two role-link "VIP" entries should NOT beat one role-button "任思文"
  const evidence: UsernameEvidence[] = [
    { text: "VIP", strategy: "role-link", priority: 1, source: "role:link" },
    { text: "VIP", strategy: "role-link", priority: 1, source: "role:link" },
    { text: "任思文", strategy: "role-button", priority: 1, source: "role:button" },
  ];
  const result = pickBestUsername(evidence);
  assert.equal(result.found, true);
  if (result.found) {
    // "任思文" is a CJK name (bonus) and "VIP" duplicates from same strategy get no bonus
    assert.equal(result.username, "任思文");
  }
});

test("pickBestUsername returns found=false for empty evidence", () => {
  assert.deepEqual(pickBestUsername([]), { found: false });
});

// ---------------------------------------------------------------------------
// Position-based scoring (xRatio)
// ---------------------------------------------------------------------------

test("scoreUsernameEvidence: rightmost element gets position bonus", () => {
  const left: UsernameEvidence = {
    text: "职位X",
    strategy: "role-link",
    priority: 1,
    source: "role:link",
    xRatio: 0.1,
  };
  const right: UsernameEvidence = {
    text: "任思文",
    strategy: "role-link",
    priority: 1,
    source: "role:link",
    xRatio: 0.9,
  };
  assert.ok(scoreUsernameEvidence(right) < scoreUsernameEvidence(left));
});

test("pickBestUsername: right-side element wins over left-side nav link", () => {
  const evidence: UsernameEvidence[] = [
    { text: "首页X", strategy: "role-link", priority: 1, source: "role:link", xRatio: 0.1 },
    { text: "任思文", strategy: "role-link", priority: 1, source: "role:link", xRatio: 0.85 },
  ];
  const result = pickBestUsername(evidence);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.username, "任思文");
  }
});

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

test("selectExistingZhipinPage returns undefined when no tracked page state exists", async () => {
  let useTrackedPageCalled = false;
  const ctxManager = {
    getPageCount(platform: string) {
      assert.equal(platform, "zhipin");
      return 0;
    },
    async useTrackedPage() {
      useTrackedPageCalled = true;
      return undefined;
    },
  } as unknown as BrowserContextManager;

  const page = await selectExistingZhipinPage(ctxManager);

  assert.equal(page, undefined);
  assert.equal(useTrackedPageCalled, false);
});

test("selectExistingZhipinPage continues through tracked-page selection when only native state exists", async () => {
  const trackedPage = {
    url() {
      return "https://www.zhipin.com/web/chat/index";
    },
  } as unknown as Page;
  let predicateResult = false;

  const ctxManager = {
    getPageCount(platform: string) {
      assert.equal(platform, "zhipin");
      return 1;
    },
    async useTrackedPage(platform: string, predicate: (page: Page) => boolean) {
      assert.equal(platform, "zhipin");
      predicateResult = predicate(trackedPage);
      return trackedPage;
    },
  } as unknown as BrowserContextManager;

  const page = await selectExistingZhipinPage(ctxManager);

  assert.equal(page, trackedPage);
  assert.equal(predicateResult, true);
});
