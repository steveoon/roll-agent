import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBundledRollInvocation } from "../companion-host/invocation.ts";
import {
  createMacOsLaunchAgentPlanForIdentity,
  createWindowsScheduledTaskPlanForIdentity,
} from "../companion-host/service.ts";
import { SCHEDULER_SERVICE_LABEL, createSchedulerPaths } from "./paths.ts";
import {
  installSchedulerServiceControllerSafely,
  schedulerServiceIdentity,
  withSchedulerServiceManagementLock,
} from "./service.ts";

test("scheduler service identity 指向 roll schedule daemon --foreground", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: ["--experimental-strip-types", "--inspect"],
  });
  const home = "/Users/tester";
  const dataDir = resolve(home, ".roll-agent", "scheduler");
  const identity = schedulerServiceIdentity(createSchedulerPaths(dataDir, home), invocation, {
    maxConcurrentRuns: 3,
  });
  assert.equal(identity.label, SCHEDULER_SERVICE_LABEL);
  assert.equal(
    identity.plistPath,
    join(home, "Library", "LaunchAgents", "dev.roll-agent.scheduler.plist"),
  );
  assert.equal(identity.logPath, join(dataDir, "scheduler.log"));
  assert.deepEqual(identity.programArguments, [
    "/bundle/node",
    "--experimental-strip-types",
    "/bundle/roll.js",
    "schedule",
    "daemon",
    "--foreground",
    "--data-dir",
    dataDir,
    "--max-concurrent-runs",
    "3",
  ]);
  const plan = createMacOsLaunchAgentPlanForIdentity(identity, 501);
  assert.equal(plan.serviceTarget, `gui/501/${SCHEDULER_SERVICE_LABEL}`);
});

test("scheduler service management lock serializes install and uninstall across data-dir changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-lock-"));
  let releaseFirst: (() => void) | undefined;
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const first = withSchedulerServiceManagementLock(async () => {
      markEntered?.();
      await gate;
      return "first";
    }, home);
    await entered;
    await assert.rejects(
      withSchedulerServiceManagementLock(async () => "second", home),
      /另一个 roll schedule service/u,
    );
    releaseFirst?.();
    assert.equal(await first, "first");
    assert.equal(
      await withSchedulerServiceManagementLock(async () => "after-release", home),
      "after-release",
    );
  } finally {
    releaseFirst?.();
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed scheduler service install disables and stops a partially registered task", async () => {
  const events: string[] = [];
  const controller = {
    install: async () => {
      events.push("install");
      throw new Error("start failed");
    },
    uninstall: async () => undefined,
    start: async () => undefined,
    status: async () => ({ installed: true, running: false, enabled: true }),
    disable: async () => {
      events.push("disable");
    },
    stop: async () => {
      events.push("stop");
    },
  };

  await assert.rejects(installSchedulerServiceControllerSafely(controller), /start failed/u);
  assert.deepEqual(events, ["install", "disable", "stop"]);
});

test("failed scheduler service install still disables when Task status is unreadable", async () => {
  const events: string[] = [];
  const controller = {
    install: async () => {
      events.push("install");
      throw new Error("run failed");
    },
    uninstall: async () => undefined,
    start: async () => undefined,
    status: async () => {
      events.push("status-error");
      throw new Error("query failed");
    },
    disable: async () => {
      events.push("disable");
    },
    stop: async () => {
      events.push("stop");
    },
  };

  await assert.rejects(installSchedulerServiceControllerSafely(controller), /run failed/u);
  assert.deepEqual(events, ["install", "status-error", "disable", "stop"]);
});

test("scheduler identity 携带 Windows XML 路径与显示名", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: [],
  });
  const home = "/Users/tester";
  const dataDir = resolve(home, ".roll-agent", "scheduler");
  const identity = schedulerServiceIdentity(createSchedulerPaths(dataDir, home), invocation, {
    maxConcurrentRuns: 2,
  });
  assert.equal(identity.displayName, "roll schedule daemon");
  assert.equal(identity.windowsTaskXmlPath, join(dataDir, "scheduler-task.xml"));
});

test("Windows plan 不再把命令行塞进 /TR，长路径也能注册", () => {
  const longEntrypoint = `C:\\Users\\tester\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@roll-agent+core@0.12.0\\node_modules\\@roll-agent\\core\\bin\\roll.js`;
  const invocation = createBundledRollInvocation({
    command: "C:\\Program Files\\nodejs\\node.exe",
    cliEntrypoint: longEntrypoint,
    execArgv: ["--disable-warning=ExperimentalWarning", "--experimental-sqlite"],
  });
  const identity = schedulerServiceIdentity(
    createSchedulerPaths("C:\\Users\\tester\\.roll-agent\\scheduler", "C:\\Users\\tester"),
    invocation,
    { maxConcurrentRuns: 2 },
  );
  const plan = createWindowsScheduledTaskPlanForIdentity(identity, "C:\\Windows");
  assert.ok(plan.taskCommand.length > 261);
  assert.equal(plan.create.args.includes("/TR"), false);
  assert.equal(plan.create.args.includes(plan.taskCommand), false);
  const xml = plan.renderTaskXml({ userId: "S-1-5-21-1-2-3-1001" });
  assert.ok(xml.includes(`<Command>${invocation.command}</Command>`));
  assert.match(xml, /"--max-concurrent-runs" "2"<\/Arguments>/u);
  assert.match(xml, /<Description>roll schedule daemon<\/Description>/u);
});
