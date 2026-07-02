import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeUsageParts,
  contextPressure,
  formatThroughput,
  formatTokens,
  formatUsageLine,
  sessionTotal,
} from "./token-format.ts";

test("formatTokens humanizes thousands and millions", () => {
  assert.equal(formatTokens(42), "42");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1200), "1.2k");
  assert.equal(formatTokens(131072), "131.1k");
  assert.equal(formatTokens(200_000), "200k");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_050_000), "1.1M");
});

test("sessionTotal prefers totalTokens then falls back to in+out", () => {
  assert.equal(sessionTotal({ totalTokens: 90 }), 90);
  assert.equal(sessionTotal({ inputTokens: 40, outputTokens: 50 }), 90);
  assert.equal(sessionTotal({ totalTokens: 0, inputTokens: 40, outputTokens: 50 }), 90);
});

test("computeUsageParts reports % left with adaptive baseline headroom", () => {
  const parts = computeUsageParts(
    { inputTokens: 60, outputTokens: 5 },
    { totalTokens: 90 },
    131072,
    60,
  );
  assert.equal(parts.usedTokens, 60);
  assert.equal(parts.contextWindow, 131072);
  assert.equal(parts.percentLeft, 100);
  assert.equal(parts.sessionTokens, 90);
});

test("computeUsageParts caps baseline so small windows stay meaningful", () => {
  const nearFull = computeUsageParts({ inputTokens: 1600 }, undefined, 2000, 1600);
  assert.ok(
    nearFull.percentLeft !== undefined && nearFull.percentLeft > 0 && nearFull.percentLeft < 50,
  );
  const full = computeUsageParts({ inputTokens: 2000 }, undefined, 2000, 2000);
  assert.equal(full.percentLeft, 0);
});

test("computeUsageParts omits percent without a context window", () => {
  const parts = computeUsageParts({ inputTokens: 60 }, undefined, undefined, 60);
  assert.equal(parts.percentLeft, undefined);
  assert.equal(parts.contextWindow, undefined);
});

test("computeUsageParts surfaces cached/reasoning only when positive", () => {
  const withDetail = computeUsageParts(
    { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 800, reasoningTokens: 120 },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(withDetail.cachedInputTokens, 800);
  assert.equal(withDetail.reasoningTokens, 120);
  const zeroed = computeUsageParts(
    { inputTokens: 1200, cachedInputTokens: 0, reasoningTokens: 0 },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(zeroed.cachedInputTokens, undefined);
  assert.equal(zeroed.reasoningTokens, undefined);
});

test("formatUsageLine renders codex-style line", () => {
  const line = formatUsageLine(
    computeUsageParts(
      { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 800 },
      { totalTokens: 45000 },
      200000,
      1200,
    ),
  );
  assert.ok(line);
  assert.match(line, /^↳ /);
  assert.match(line, /turn in 1\.2k \(\+800 cached\) out 340/);
  assert.match(line, /session 45k/);
  assert.match(line, /ctx 1\.2k\/200k \(\d+% left\)/);
});

test("computeUsageParts surfaces cache write tokens when positive", () => {
  const parts = computeUsageParts(
    { inputTokens: 1200, cachedInputTokens: 800, cacheWriteTokens: 200 },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(parts.cacheWriteTokens, 200);
  const line = formatUsageLine(parts);
  assert.ok(line);
  assert.match(line, /in 1\.2k \(\+800 cached, \+200 cache-write\)/);
});

test("formatThroughput rounds and hides non-positive values", () => {
  assert.equal(formatThroughput(42.6), "43 tok/s");
  assert.equal(formatThroughput(8.44), "8.4 tok/s");
  assert.equal(formatThroughput(0), undefined);
  assert.equal(formatThroughput(undefined), undefined);
});

test("contextPressure escalates at 25% and 10% left", () => {
  assert.equal(contextPressure(undefined), "ok");
  assert.equal(contextPressure(80), "ok");
  assert.equal(contextPressure(26), "ok");
  assert.equal(contextPressure(25), "warn");
  assert.equal(contextPressure(11), "warn");
  assert.equal(contextPressure(10), "critical");
  assert.equal(contextPressure(0), "critical");
});

test("formatUsageLine returns undefined with no data", () => {
  assert.equal(
    formatUsageLine(computeUsageParts(undefined, undefined, undefined, undefined)),
    undefined,
  );
});
