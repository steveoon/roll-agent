import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgentUsageRecoveryCheck,
  formatDoctorCheckLines,
  formatDoctorChecksForJsonOutput,
  formatDoctorFixLines,
  formatDoctorJsonOutput,
  isNodeVersionSupported,
} from "./doctor.ts";

describe("isNodeVersionSupported", () => {
  it("should reject versions lower than 22.6.0", () => {
    assert.equal(isNodeVersionSupported("22.5.9"), false);
    assert.equal(isNodeVersionSupported("21.9.0"), false);
  });

  it("should accept version 22.6.0 and above", () => {
    assert.equal(isNodeVersionSupported("22.6.0"), true);
    assert.equal(isNodeVersionSupported("22.7.0"), true);
    assert.equal(isNodeVersionSupported("23.0.0"), true);
  });

  it("should reject invalid version strings", () => {
    assert.equal(isNodeVersionSupported("invalid"), false);
  });
});

describe("formatDoctorCheckLines", () => {
  it("should hide fix instructions by default", () => {
    const lines = formatDoctorCheckLines(
      { name: "配置文件", status: "warn", message: "需要迁移", fix: "运行 `roll config migrate`" },
      { fixPlan: false },
    );

    assert.deepEqual(lines, ["  ⚠ 配置文件: 需要迁移"]);
  });

  it("should include fix instructions when fix-plan is enabled", () => {
    const lines = formatDoctorCheckLines(
      { name: "配置文件", status: "warn", message: "需要迁移", fix: "运行 `roll config migrate`" },
      { fixPlan: true },
    );

    assert.deepEqual(lines, ["  ⚠ 配置文件: 需要迁移", "      fix: 运行 `roll config migrate`"]);
  });
});

describe("formatDoctorChecksForJsonOutput", () => {
  it("should strip fix instructions unless fix-plan is enabled", () => {
    const checks = [
      {
        name: "配置文件",
        status: "warn" as const,
        message: "需要迁移",
        fix: "运行 `roll config migrate`",
      },
    ];

    assert.deepEqual(formatDoctorChecksForJsonOutput(checks, { fixPlan: false }), [
      { name: "配置文件", status: "warn", message: "需要迁移" },
    ]);
    assert.deepEqual(formatDoctorChecksForJsonOutput(checks, { fixPlan: true }), checks);
  });

  it("should preserve structured details in JSON output", () => {
    const checks = [
      {
        name: "Browser runtime (browser-use-agent)",
        status: "warn" as const,
        message: "runtime=boss-a:cdp=warn,profile=ok,tracking=missing",
        fix: "重启 browser-use-agent",
        details: {
          type: "browser-runtime",
          declaredInstanceIds: ["boss-a"],
          runtimeInstances: [],
        },
      },
    ];

    assert.deepEqual(formatDoctorChecksForJsonOutput(checks, { fixPlan: false }), [
      {
        name: "Browser runtime (browser-use-agent)",
        status: "warn",
        message: "runtime=boss-a:cdp=warn,profile=ok,tracking=missing",
        details: {
          type: "browser-runtime",
          declaredInstanceIds: ["boss-a"],
          runtimeInstances: [],
        },
      },
    ]);
  });
});

describe("formatDoctorJsonOutput", () => {
  it("should include fix results when doctor --fix emits JSON", () => {
    const checks = [
      {
        name: "Agent 数据目录",
        status: "ok" as const,
        message: "/tmp/roll-agent",
      },
    ];
    const fixes = [
      {
        name: "Agent 数据目录",
        status: "applied" as const,
        message: "已创建 /tmp/roll-agent",
      },
    ];

    assert.deepEqual(formatDoctorJsonOutput(checks, { fixPlan: true, fixes }), {
      checks,
      fixes,
    });
  });
});

describe("formatDoctorFixLines", () => {
  it("should format fix result lines", () => {
    assert.deepEqual(
      formatDoctorFixLines({
        name: "Agent 数据目录",
        status: "applied",
        message: "已创建 /tmp/roll-agent",
      }),
      ["  ✓ Agent 数据目录: 已创建 /tmp/roll-agent"],
    );
  });
});

describe("formatAgentUsageRecoveryCheck", () => {
  it("points recoverable interrupted releases to agent stop", () => {
    const check = formatAgentUsageRecoveryCheck({
      status: "recoverable",
      agentName: "browser-use-agent",
      releases: [],
      runtimePid: 123,
    });

    assert.ok(check);
    assert.equal(check.status, "warn");
    assert.match(check.message, /agent stop browser-use-agent/u);
    assert.match(check.fix ?? "", /agent stop browser-use-agent --recover/u);
    assert.deepEqual(check.details, {
      type: "agent-usage-stop-recovery",
      status: "recoverable",
      runtimePid: 123,
      releases: [],
      command: "roll agent stop browser-use-agent",
    });
  });

  it("does not offer automatic recovery for an unsafe lease state", () => {
    const check = formatAgentUsageRecoveryCheck({
      status: "blocked",
      agentName: "browser-use-agent",
      releases: [],
      reason: "owner identity unavailable",
    });

    assert.ok(check);
    assert.equal(check.status, "warn");
    assert.match(check.message, /无法安全自动恢复/u);
    assert.doesNotMatch(check.fix ?? "", /--recover/u);
  });
});
