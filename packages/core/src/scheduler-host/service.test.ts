import { test } from "node:test";
import assert from "node:assert/strict";
import { createBundledRollInvocation } from "../companion-host/invocation.ts";
import { createMacOsLaunchAgentPlanForIdentity } from "../companion-host/service.ts";
import { SCHEDULER_SERVICE_LABEL, createSchedulerPaths } from "./paths.ts";
import { schedulerServiceIdentity } from "./service.ts";

test("scheduler service identity 指向 roll schedule daemon --foreground", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: ["--experimental-strip-types", "--inspect"],
  });
  const identity = schedulerServiceIdentity(
    createSchedulerPaths("/Users/tester/.roll-agent/scheduler", "/Users/tester"),
    invocation,
    { maxConcurrentRuns: 3 },
  );
  assert.equal(identity.label, SCHEDULER_SERVICE_LABEL);
  assert.equal(
    identity.plistPath,
    "/Users/tester/Library/LaunchAgents/dev.roll-agent.scheduler.plist",
  );
  assert.equal(identity.logPath, "/Users/tester/.roll-agent/scheduler/scheduler.log");
  assert.deepEqual(identity.programArguments, [
    "/bundle/node",
    "--experimental-strip-types",
    "/bundle/roll.js",
    "schedule",
    "daemon",
    "--foreground",
    "--data-dir",
    "/Users/tester/.roll-agent/scheduler",
    "--max-concurrent-runs",
    "3",
  ]);
  const plan = createMacOsLaunchAgentPlanForIdentity(identity, 501);
  assert.equal(plan.serviceTarget, `gui/501/${SCHEDULER_SERVICE_LABEL}`);
});
