import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
