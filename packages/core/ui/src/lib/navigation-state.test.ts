import assert from "node:assert/strict";
import test from "node:test";
import { isConfigTargetHighlighted, matchesNavigationTarget } from "./navigation-state.ts";
import type { NavigationTarget } from "../types.ts";

const rollTarget: NavigationTarget = { type: "roll", key: "llm" };
const agentTarget: NavigationTarget = { type: "agent", name: "octopus-agent" };

test("matchesNavigationTarget matches identical roll and agent targets only", () => {
  assert.equal(matchesNavigationTarget(rollTarget, { type: "roll", key: "llm" }), true);
  assert.equal(matchesNavigationTarget(rollTarget, { type: "roll", key: "ask" }), false);
  assert.equal(
    matchesNavigationTarget(agentTarget, { type: "agent", name: "octopus-agent" }),
    true,
  );
  assert.equal(
    matchesNavigationTarget(agentTarget, { type: "agent", name: "smart-reply-agent" }),
    false,
  );
  assert.equal(matchesNavigationTarget(rollTarget, agentTarget), false);
});

test("config targets keep their highlight while the config view is active", () => {
  assert.equal(isConfigTargetHighlighted(agentTarget, agentTarget, false), true);
  assert.equal(isConfigTargetHighlighted(agentTarget, rollTarget, false), false);
});

test("the Companion view clears every config highlight", () => {
  assert.equal(isConfigTargetHighlighted(agentTarget, agentTarget, true), false);
  assert.equal(isConfigTargetHighlighted(rollTarget, rollTarget, true), false);
});
