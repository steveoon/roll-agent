import assert from "node:assert/strict";
import test from "node:test";
import { createBundledRollInvocation } from "./invocation.ts";
import { createCompanionPaths } from "./paths.ts";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "./process-runner.ts";
import {
  companionServiceIdentity,
  createMacOsLaunchAgentPlan,
  createMacOsLaunchAgentPlanForIdentity,
  createWindowsScheduledTaskPlan,
  createWindowsScheduledTaskPlanForIdentity,
  WindowsScheduledTaskController,
} from "./service.ts";

const invocation = createBundledRollInvocation({
  command: "/Applications/Roll Companion.app/Contents/Frameworks/node",
  cliEntrypoint: "/Applications/Roll Companion.app/Contents/Resources/roll.js",
  execArgv: [],
});

test("macOS plan is a per-user LaunchAgent using only absolute bundled paths", () => {
  const plan = createMacOsLaunchAgentPlan({
    paths: createCompanionPaths("/Users/tester", "darwin"),
    invocation,
    uid: 501,
  });
  assert.equal(plan.domainTarget, "gui/501");
  assert.match(plan.plistPath, /Library\/LaunchAgents/);
  assert.match(plan.plist, /<key>RunAtLoad<\/key>/);
  assert.match(plan.plist, /\/Applications\/Roll Companion\.app/);
  assert.doesNotMatch(plan.plist, /ProgramArguments>[\s\S]*<string>roll<\/string>/);
});

test("Windows plan is current-user ONLOGON and never SYSTEM", () => {
  const plan = createWindowsScheduledTaskPlan(invocation, "D:\\Windows");
  assert.ok(plan.create.args.includes("ONLOGON"));
  assert.ok(plan.create.args.includes("LIMITED"));
  assert.equal(plan.create.args.includes("SYSTEM"), false);
  assert.equal(plan.create.command, "D:\\Windows\\System32\\schtasks.exe");
  assert.equal(plan.start.command, "D:\\Windows\\System32\\schtasks.exe");
  assert.equal(
    plan.query.command,
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  const queryScript = plan.query.args.at(-1) ?? "";
  assert.ok(queryScript.includes("$service.GetFolder('\\').GetTasks(1)"));
  assert.doesNotMatch(queryScript, /\$args\[0\]/u);
  assert.match(plan.taskCommand, /^"\/Applications\/Roll Companion\.app/);
  assert.match(plan.taskCommand, /"--foreground"$/);
});

test("Windows service status uses locale-independent Task Scheduler state values", async () => {
  const runner = new QueueRunner([{ code: 0, stdout: "state:4", stderr: "" }]);
  const controller = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan(invocation, "D:\\Windows"),
    runner,
  );
  assert.deepEqual(await controller.status(), { installed: true, running: true });
  assert.match(runner.invocations[0]?.args.join(" ") ?? "", /Schedule\.Service/u);
});

test("Windows service status distinguishes a missing task and fails closed on invalid output", async () => {
  const missing = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan(invocation, "D:\\Windows"),
    new QueueRunner([{ code: 0, stdout: "missing", stderr: "" }]),
  );
  assert.deepEqual(await missing.status(), { installed: false, running: false });

  const invalid = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan(invocation, "D:\\Windows"),
    new QueueRunner([{ code: 0, stdout: "Status: Running", stderr: "" }]),
  );
  await assert.rejects(invalid.status(), /invalid state/u);
});

test("Windows service status fails closed for unknown and queued task states", async () => {
  for (const state of ["state:0", "state:2"]) {
    const controller = new WindowsScheduledTaskController(
      createWindowsScheduledTaskPlan(invocation, "D:\\Windows"),
      new QueueRunner([{ code: 0, stdout: state, stderr: "" }]),
    );
    await assert.rejects(controller.status(), /state is indeterminate/u);
  }
});

test("Windows service stop verifies the task is no longer running", async () => {
  const runner = new QueueRunner([
    { code: 0, stdout: "state:4", stderr: "" },
    { code: 1, stdout: "", stderr: "already stopping" },
    { code: 0, stdout: "state:3", stderr: "" },
  ]);
  const plan = createWindowsScheduledTaskPlan(invocation, "D:\\Windows");
  const controller = new WindowsScheduledTaskController(plan, runner);
  await controller.stop();
  assert.deepEqual(runner.invocations, [plan.query, plan.stop, plan.query]);
});

test("Windows service stop rejects when the task remains running", async () => {
  const controller = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan(invocation, "D:\\Windows"),
    new QueueRunner([
      { code: 0, stdout: "state:4", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "state:4", stderr: "" },
    ]),
  );
  await assert.rejects(controller.stop(), /Unable to stop/u);
});

test("Windows service stop ends a queued task and requires a safe final state", async () => {
  const runner = new QueueRunner([
    { code: 0, stdout: "state:2", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "state:3", stderr: "" },
  ]);
  const plan = createWindowsScheduledTaskPlan(invocation, "D:\\Windows");
  await new WindowsScheduledTaskController(plan, runner).stop();
  assert.deepEqual(runner.invocations, [plan.query, plan.stop, plan.query]);
});

class QueueRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];
  private readonly results: ProcessResult[];

  constructor(results: ProcessResult[]) {
    this.results = [...results];
  }

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("Unexpected process invocation");
    }
    return result;
  }
}

test("identity-based plans keep companion defaults and accept other daemons", () => {
  const companion = createMacOsLaunchAgentPlan({
    paths: createCompanionPaths("/Users/tester", "darwin"),
    invocation,
    uid: 501,
  });
  const viaIdentity = createMacOsLaunchAgentPlanForIdentity(
    companionServiceIdentity(createCompanionPaths("/Users/tester", "darwin"), invocation),
    501,
  );
  assert.deepEqual(viaIdentity, companion);
  const other = createMacOsLaunchAgentPlanForIdentity(
    {
      label: "dev.roll-agent.other",
      plistPath: "/Users/tester/Library/LaunchAgents/dev.roll-agent.other.plist",
      logPath: "/Users/tester/.roll-agent/other/other.log",
      windowsTaskName: "Roll Agent Other",
      programArguments: ["/bundle/node", "/bundle/roll.js", "other", "--foreground"],
    },
    501,
  );
  assert.equal(other.label, "dev.roll-agent.other");
  assert.equal(other.serviceTarget, "gui/501/dev.roll-agent.other");
  assert.match(other.plist, /<string>dev\.roll-agent\.other<\/string>/u);
  assert.match(other.plist, /other\.log/u);
  const windows = createWindowsScheduledTaskPlanForIdentity(
    {
      windowsTaskName: "Roll Agent Other",
      programArguments: ["C:\\node.exe", "C:\\roll.js", "other"],
    },
    "D:\\Windows",
  );
  assert.equal(windows.taskName, "Roll Agent Other");
  assert.ok(windows.create.args.includes("Roll Agent Other"));
});
