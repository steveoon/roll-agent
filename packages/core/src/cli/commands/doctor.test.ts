import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgentUsageRecoveryCheck,
  formatDoctorCheckLines,
  formatDoctorChecksForJsonOutput,
  formatDoctorFixLines,
  formatDoctorJsonOutput,
  isNodeVersionSupported,
  formatSchedulerServiceCheck,
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

describe("formatSchedulerServiceCheck", () => {
  const current = {
    command: "/n/v24/bin/node",
    cliEntrypoint: "/n/v24/roll.js",
    rollVersion: "1.0.1",
  };

  it("reports ok when the service is not installed", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "missing",
      installed: false,
      running: false,
    });
    assert.equal(check.status, "ok");
    assert.match(check.message, /未安装/u);
  });

  it("fails when the pinned node or entrypoint no longer exists", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "valid",
      installed: true,
      running: false,
      binary: {
        status: "broken",
        recorded: { ...current, command: "/n/v22/bin/node" },
        current,
        commandExists: false,
        entrypointExists: true,
        versionMismatch: false,
        reason: "服务定义指向的 node 已不存在：/n/v22/bin/node",
      },
    });
    assert.equal(check.status, "fail");
    assert.match(check.message, /\/n\/v22\/bin\/node/u);
    assert.match(check.fix ?? "", /roll schedule service restart/u);
    assert.deepEqual(check.details, {
      type: "scheduler-service",
      binary: "broken",
      running: false,
    });
  });

  it("warns when the daemon still runs an older roll than the current install", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "valid",
      installed: true,
      running: true,
      binary: {
        status: "outdated",
        recorded: { ...current, rollVersion: "1.0.0" },
        current,
        commandExists: true,
        entrypointExists: true,
        versionMismatch: true,
        reason: "服务定义指向 roll v1.0.0，当前为 v1.0.1",
      },
    });
    assert.equal(check.status, "warn");
    assert.match(check.message, /v1\.0\.0/u);
    assert.match(check.fix ?? "", /roll schedule service restart/u);
  });

  it("warns when installed but the daemon is not running even though the binary is current", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "valid",
      installed: true,
      running: false,
      binary: {
        status: "current",
        recorded: current,
        current,
        commandExists: true,
        entrypointExists: true,
        versionMismatch: false,
        reason: undefined,
      },
    });
    assert.equal(check.status, "warn");
    assert.match(check.message, /daemon 未运行/u);
    assert.match(check.fix ?? "", /roll schedule service status/u);
  });

  it("is ok when installed, running and current", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "valid",
      installed: true,
      running: true,
      binary: {
        status: "current",
        recorded: current,
        current,
        commandExists: true,
        entrypointExists: true,
        versionMismatch: false,
        reason: undefined,
      },
    });
    assert.equal(check.status, "ok");
    assert.match(check.message, /v1\.0\.1/u);
  });

  it("warns while service metadata is still installing even if the OS job is running", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "valid",
      metadataPhase: "installing",
      installed: true,
      running: true,
      binary: {
        status: "current",
        recorded: current,
        current,
        commandExists: true,
        entrypointExists: true,
        versionMismatch: false,
        reason: undefined,
      },
    });
    assert.equal(check.status, "warn");
    assert.match(check.message, /installing/u);
    assert.match(check.fix ?? "", /roll schedule service restart/u);
  });

  it("warns when the probe itself failed", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "missing",
      installed: false,
      running: false,
      error: "launchctl unavailable",
    });
    assert.equal(check.status, "warn");
    assert.match(check.message, /launchctl unavailable/u);
  });

  it("fails on unparseable metadata because every claim is blocked until it is cleared", () => {
    const check = formatSchedulerServiceCheck({
      metadataStatus: "invalid",
      installed: false,
      running: false,
      error: "metadata 损坏",
    });
    assert.equal(check.status, "fail");
    assert.match(check.message, /metadata 损坏/u);
    assert.match(check.message, /阻塞/u);
    assert.match(check.fix ?? "", /roll schedule service uninstall/u);
  });
});
