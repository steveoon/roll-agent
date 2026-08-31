import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULER_SERVICE_BINARY_STATUSES,
  SCHEDULER_SERVICE_RESTART_COMMAND,
  describeSchedulerServiceBinary,
} from "./service-binary.ts";

const current = {
  command: "/nvm/v24/bin/node",
  cliEntrypoint: "/nvm/v24/lib/node_modules/@roll-agent/core/dist/cli/index.js",
  rollVersion: "0.9.1",
};

test("未记录 binary 的旧 metadata 报 unknown，并提示重装后才可检测", () => {
  const report = describeSchedulerServiceBinary(undefined, current, () => true);
  assert.equal(report.status, SCHEDULER_SERVICE_BINARY_STATUSES.unknown);
  assert.equal(report.recorded, undefined);
  assert.match(report.reason ?? "", /未记录/u);
  assert.match(report.reason ?? "", new RegExp(SCHEDULER_SERVICE_RESTART_COMMAND, "u"));
});

test("固化的 node 或 CLI 入口已不存在时报 broken，指出缺失路径", () => {
  const recorded = { ...current, command: "/nvm/v22/bin/node" };
  const report = describeSchedulerServiceBinary(
    recorded,
    current,
    (path) => path !== recorded.command,
  );
  assert.equal(report.status, SCHEDULER_SERVICE_BINARY_STATUSES.broken);
  assert.equal(report.commandExists, false);
  assert.equal(report.entrypointExists, true);
  assert.match(report.reason ?? "", /node 已不存在/u);
  assert.match(report.reason ?? "", /\/nvm\/v22\/bin\/node/u);
  assert.match(report.reason ?? "", new RegExp(SCHEDULER_SERVICE_RESTART_COMMAND, "u"));
});

test("路径都存在但版本或路径与当前 roll 不同时报 outdated", () => {
  const byVersion = describeSchedulerServiceBinary(
    { ...current, rollVersion: "0.9.0" },
    current,
    () => true,
  );
  assert.equal(byVersion.status, SCHEDULER_SERVICE_BINARY_STATUSES.outdated);
  assert.equal(byVersion.versionMismatch, true);
  assert.match(byVersion.reason ?? "", /v0\.9\.0/u);
  assert.match(byVersion.reason ?? "", /v0\.9\.1/u);
  assert.doesNotMatch(byVersion.reason ?? "", /正在运行的 daemon/u);
  const byPath = describeSchedulerServiceBinary(
    { ...current, command: "/nvm/v22/bin/node" },
    current,
    () => true,
  );
  assert.equal(byPath.status, SCHEDULER_SERVICE_BINARY_STATUSES.outdated);
  assert.equal(byPath.versionMismatch, false);
  assert.match(byPath.reason ?? "", /node 与当前不同/u);
});

test("记录与当前完全一致时报 current 且无 reason", () => {
  const report = describeSchedulerServiceBinary(current, current, () => true);
  assert.equal(report.status, SCHEDULER_SERVICE_BINARY_STATUSES.current);
  assert.equal(report.reason, undefined);
  assert.equal(report.commandExists, true);
  assert.equal(report.entrypointExists, true);
  assert.equal(report.versionMismatch, false);
});
