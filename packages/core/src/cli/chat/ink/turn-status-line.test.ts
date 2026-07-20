import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "./display-width.ts";
import {
  composeTurnStatusLayout,
  composeTurnStatusLine,
  formatElapsed,
} from "./turn-status-line.ts";
import { TURN_ACTIVITY_KINDS, type TurnActivity } from "./turn-activity.ts";

const WAITING: TurnActivity = {
  kind: TURN_ACTIVITY_KINDS.waitingModel,
  key: TURN_ACTIVITY_KINDS.waitingModel,
  label: "等待模型响应…",
  animated: true,
  showPhaseElapsed: true,
};

test("formatElapsed uses compact second and minute labels", () => {
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(14_999), "14s");
  assert.equal(formatElapsed(184_000), "3m4s");
});

test("composeTurnStatusLayout hides the phase timer within the first second", () => {
  const layout = composeTurnStatusLayout(WAITING, 800, 30_000, 60);
  assert.equal(layout.phaseTime, undefined);
  const line = composeTurnStatusLine(WAITING, 800, 30_000, 60);
  assert.match(line, /^等待模型响应…\s+本轮 30s$/);
  assert.equal(displayWidth(line), 60);
});

test("composeTurnStatusLine shows phase and total timers on a wide terminal", () => {
  const line = composeTurnStatusLine(WAITING, 14_000, 184_000, 60);
  assert.match(line, /^等待模型响应… {2}14s/);
  assert.match(line, /本轮 3m4s$/);
  assert.equal(displayWidth(line), 60);
});

test("composeTurnStatusLine reserves the total timer before truncating CJK activity", () => {
  const tool: TurnActivity = {
    kind: TURN_ACTIVITY_KINDS.tool,
    key: "tool:c1",
    label: "执行 browser-use-agent.读取当前页面并分析所有可交互元素…",
    animated: true,
    showPhaseElapsed: true,
  };
  const line = composeTurnStatusLine(tool, 8_000, 72_000, 28);
  assert.equal(displayWidth(line), 28);
  assert.match(line, /…/);
  assert.match(line, /本轮 1m12s$/);
});

test("composeTurnStatusLine omits a phase timer while waiting for confirmation", () => {
  const confirmation: TurnActivity = {
    kind: TURN_ACTIVITY_KINDS.waitingUser,
    key: "waiting-user:a1",
    label: "等待你确认…",
    animated: false,
    showPhaseElapsed: false,
  };
  const line = composeTurnStatusLine(confirmation, 90_000, 91_000, 40);
  assert.match(line, /^等待你确认…\s+/);
  assert.doesNotMatch(line, /等待你确认… 1m30s/);
  assert.match(line, /本轮 1m31s$/);
});
