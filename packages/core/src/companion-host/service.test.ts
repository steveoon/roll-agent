import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  encodeWindowsTaskXml,
  WindowsScheduledTaskController,
} from "./service.ts";

const invocation = createBundledRollInvocation({
  command: "/Applications/Roll Companion.app/Contents/Frameworks/node",
  cliEntrypoint: "/Applications/Roll Companion.app/Contents/Resources/roll.js",
  execArgv: [],
});

const windowsPaths = createCompanionPaths("C:\\Users\\tester", "win32");

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

test("Windows plan registers through an XML task definition, never through /TR", () => {
  const plan = createWindowsScheduledTaskPlan({
    paths: windowsPaths,
    invocation,
    windowsDirectory: "D:\\Windows",
  });
  assert.deepEqual(plan.create.args, [
    "/Create",
    "/F",
    "/XML",
    windowsPaths.windowsTaskXmlPath,
    "/TN",
    "Roll Agent Companion",
  ]);
  assert.equal(plan.create.command, "D:\\Windows\\System32\\schtasks.exe");
  assert.equal(plan.whoAmI.command, "D:\\Windows\\System32\\whoami.exe");
  assert.deepEqual(plan.whoAmI.args, ["/user", "/fo", "csv", "/nh"]);
  assert.equal(
    plan.query.command,
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  const xml = plan.renderTaskXml({ userId: "S-1-5-21-1-2-3-1001" });
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(xml, /<Principal id="Author">\s*<UserId>S-1-5-21-1-2-3-1001<\/UserId>/u);
  assert.match(
    xml,
    /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-1-2-3-1001<\/UserId>/u,
  );
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/u);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/u);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/u);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/u);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(
    xml,
    /<Command>\/Applications\/Roll Companion\.app\/Contents\/Frameworks\/node<\/Command>/u,
  );
  assert.match(
    xml,
    /<Arguments>"\/Applications\/Roll Companion\.app[^<]*"--foreground"<\/Arguments>/u,
  );
  assert.doesNotMatch(xml, /S-1-5-18|SYSTEM|HighestAvailable/u);
  assert.match(xml, /<Description>Roll Companion<\/Description>/u);
});

test("Windows task XML is encoded as UTF-16LE with BOM", () => {
  const encoded = encodeWindowsTaskXml("<a>é</a>");
  assert.deepEqual([...encoded.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(encoded.subarray(2).toString("utf16le"), "<a>é</a>");
});

test("Windows install resolves the user SID, writes the XML, registers and starts the task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-win-task-"));
  try {
    const paths = { ...windowsPaths, windowsTaskXmlPath: join(dir, "companion-task.xml") };
    const plan = createWindowsScheduledTaskPlan({
      paths,
      invocation,
      windowsDirectory: "D:\\Windows",
    });
    const runner = new QueueRunner([
      { code: 0, stdout: '"DESKTOP\\tester","S-1-5-21-1-2-3-1001"\r\n', stderr: "" },
      { code: 0, stdout: "SUCCESS", stderr: "" },
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    await new WindowsScheduledTaskController(plan, runner).install();
    assert.deepEqual(runner.invocations, [plan.whoAmI, plan.create, plan.query, plan.start]);
    const written = readFileSync(paths.windowsTaskXmlPath);
    assert.deepEqual([...written.subarray(0, 2)], [0xff, 0xfe]);
    assert.match(written.subarray(2).toString("utf16le"), /<UserId>S-1-5-21-1-2-3-1001<\/UserId>/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows install fails closed when the user SID cannot be read", async () => {
  const plan = createWindowsScheduledTaskPlan({
    paths: windowsPaths,
    invocation,
    windowsDirectory: "D:\\Windows",
  });
  const runner = new QueueRunner([{ code: 1, stdout: "", stderr: "denied" }]);
  await assert.rejects(
    new WindowsScheduledTaskController(plan, runner).install(),
    /Unable to identify the current Windows user for the Roll Companion task/u,
  );
  assert.equal(runner.invocations.length, 1);
});

test("Windows uninstall removes the task and its XML definition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-win-task-"));
  try {
    const paths = { ...windowsPaths, windowsTaskXmlPath: join(dir, "companion-task.xml") };
    const plan = createWindowsScheduledTaskPlan({
      paths,
      invocation,
      windowsDirectory: "D:\\Windows",
    });
    writeFileSync(paths.windowsTaskXmlPath, "stale");
    const runner = new QueueRunner([
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "SUCCESS", stderr: "" },
    ]);
    await new WindowsScheduledTaskController(plan, runner).uninstall();
    assert.deepEqual(runner.invocations, [
      plan.query,
      plan.stop,
      plan.query,
      plan.query,
      plan.remove,
    ]);
    assert.equal(existsSync(paths.windowsTaskXmlPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows controller error copy names the service being managed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-win-task-"));
  try {
    const plan = createWindowsScheduledTaskPlan({
      paths: { ...windowsPaths, windowsTaskXmlPath: join(dir, "t.xml") },
      invocation,
      windowsDirectory: "D:\\Windows",
    });
    const runner = new QueueRunner([
      { code: 0, stdout: '"DESKTOP\\tester","S-1-5-21-1-2-3-1001"\r\n', stderr: "" },
      { code: 1, stdout: "", stderr: "ERROR: Access is denied." },
    ]);
    assert.equal(plan.displayName, "Roll Companion");
    await assert.rejects(
      new WindowsScheduledTaskController(plan, runner).install(),
      /Unable to install the current-user Roll Companion task/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows service status uses locale-independent Task Scheduler state values", async () => {
  const runner = new QueueRunner([{ code: 0, stdout: "state:4", stderr: "" }]);
  const controller = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan({
      paths: windowsPaths,
      invocation,
      windowsDirectory: "D:\\Windows",
    }),
    runner,
  );
  assert.deepEqual(await controller.status(), { installed: true, running: true });
  assert.match(runner.invocations[0]?.args.join(" ") ?? "", /Schedule\.Service/u);
});

test("Windows service status distinguishes a missing task and fails closed on invalid output", async () => {
  const missing = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan({
      paths: windowsPaths,
      invocation,
      windowsDirectory: "D:\\Windows",
    }),
    new QueueRunner([{ code: 0, stdout: "missing", stderr: "" }]),
  );
  assert.deepEqual(await missing.status(), { installed: false, running: false });

  const invalid = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan({
      paths: windowsPaths,
      invocation,
      windowsDirectory: "D:\\Windows",
    }),
    new QueueRunner([{ code: 0, stdout: "Status: Running", stderr: "" }]),
  );
  await assert.rejects(invalid.status(), /invalid state/u);
});

test("Windows service status fails closed for unknown and queued task states", async () => {
  for (const state of ["state:0", "state:2"]) {
    const controller = new WindowsScheduledTaskController(
      createWindowsScheduledTaskPlan({
        paths: windowsPaths,
        invocation,
        windowsDirectory: "D:\\Windows",
      }),
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
  const plan = createWindowsScheduledTaskPlan({
    paths: windowsPaths,
    invocation,
    windowsDirectory: "D:\\Windows",
  });
  const controller = new WindowsScheduledTaskController(plan, runner);
  await controller.stop();
  assert.deepEqual(runner.invocations, [plan.query, plan.stop, plan.query]);
});

test("Windows service stop rejects when the task remains running", async () => {
  const controller = new WindowsScheduledTaskController(
    createWindowsScheduledTaskPlan({
      paths: windowsPaths,
      invocation,
      windowsDirectory: "D:\\Windows",
    }),
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
  const plan = createWindowsScheduledTaskPlan({
    paths: windowsPaths,
    invocation,
    windowsDirectory: "D:\\Windows",
  });
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
      displayName: "Roll Other",
      plistPath: "/Users/tester/Library/LaunchAgents/dev.roll-agent.other.plist",
      logPath: "/Users/tester/.roll-agent/other/other.log",
      windowsTaskName: "Roll Agent Other",
      windowsTaskXmlPath: "C:\\Users\\tester\\.roll-agent\\other\\other-task.xml",
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
      windowsTaskXmlPath: "C:\\Users\\tester\\.roll-agent\\other\\other-task.xml",
      displayName: "Roll Other",
      programArguments: ["C:\\node.exe", "C:\\roll.js", "other"],
    },
    "D:\\Windows",
  );
  assert.equal(windows.taskName, "Roll Agent Other");
  assert.ok(windows.create.args.includes("Roll Agent Other"));
});
