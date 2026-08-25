import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import type { RollConfig } from "../config/schema.ts";
import { computeAuthorityDigest, describeAuthorityDrift } from "./authority.ts";

function withApproval(
  approval: Partial<RollConfig["runtime"]["approval"]>,
  shell: Partial<RollConfig["runtime"]["shell"]> = {},
): RollConfig {
  return {
    ...DEFAULT_CONFIG,
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      approval: { ...DEFAULT_CONFIG.runtime.approval, ...approval },
      shell: { ...DEFAULT_CONFIG.runtime.shell, ...shell },
    },
  };
}

test("computeAuthorityDigest 对 overrides 顺序不敏感，对审批/shell 变化敏感", () => {
  const base = computeAuthorityDigest(
    withApproval({ overrides: { "a.tool": "auto", "b.tool": "confirm" } }),
  );
  assert.match(base, /^v1:[a-f0-9]{64}$/u);
  assert.equal(
    computeAuthorityDigest(withApproval({ overrides: { "b.tool": "confirm", "a.tool": "auto" } })),
    base,
  );
  assert.notEqual(
    computeAuthorityDigest(withApproval({ overrides: { "a.tool": "auto", "b.tool": "auto" } })),
    base,
  );
  assert.notEqual(
    computeAuthorityDigest(
      withApproval({ default: "auto", overrides: { "a.tool": "auto", "b.tool": "confirm" } }),
    ),
    base,
  );
  assert.notEqual(
    computeAuthorityDigest(
      withApproval({ overrides: { "a.tool": "auto", "b.tool": "confirm" } }, { enabled: true }),
    ),
    base,
  );
});

test("computeAuthorityDigest 忽略与权限无关的配置变化", () => {
  const config = withApproval({});
  const changed: RollConfig = {
    ...config,
    runtime: { ...config.runtime, maxSteps: config.runtime.maxSteps + 1 },
  };
  assert.equal(computeAuthorityDigest(changed), computeAuthorityDigest(config));
});

test("describeAuthorityDrift 指向 roll schedule resume", () => {
  const message = describeAuthorityDrift("sched-1", undefined, `v1:${"a".repeat(64)}`);
  assert.match(message, /未记录/u);
  assert.match(message, /roll schedule resume sched-1/u);
});
