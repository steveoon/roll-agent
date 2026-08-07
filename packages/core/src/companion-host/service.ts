import { access, chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { COMPANION_SERVICE_LABEL, WINDOWS_COMPANION_TASK_NAME } from "./constants.ts";
import type { CompanionPaths } from "./paths.ts";
import type { BundledRollInvocation } from "./invocation.ts";
import {
  SpawnProcessRunner,
  type ProcessInvocation,
  type ProcessRunner,
} from "./process-runner.ts";
import { createPowerShellUtf8StringExpression } from "./windows-powershell.ts";
import {
  resolveWindowsPowerShellExecutable,
  resolveWindowsScheduledTasksExecutable,
} from "./windows-system.ts";

const WINDOWS_TASK_STATES = {
  unknown: 0,
  disabled: 1,
  queued: 2,
  ready: 3,
  running: 4,
} as const;

type WindowsTaskState = (typeof WINDOWS_TASK_STATES)[keyof typeof WINDOWS_TASK_STATES];
const WINDOWS_TASK_STATE_VALUES: ReadonlySet<number> = new Set(Object.values(WINDOWS_TASK_STATES));

const WINDOWS_TASK_STATE_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$tasks = $service.GetFolder('\').GetTasks(1)
$task = $null
foreach ($candidate in $tasks) {
  if ($candidate.Name -eq $taskName) {
    $task = $candidate
    break
  }
}
if ($null -eq $task) {
  [Console]::Out.Write('missing')
  exit 0
}
[Console]::Out.Write('state:' + [int]$task.State)
`;

export interface CompanionServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
}

export interface CompanionServiceController {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<CompanionServiceStatus>;
}

export interface MacOsLaunchAgentPlan {
  readonly label: string;
  readonly plistPath: string;
  readonly plist: string;
  readonly domainTarget: string;
  readonly serviceTarget: string;
}

export function createMacOsLaunchAgentPlan(input: {
  readonly paths: CompanionPaths;
  readonly invocation: BundledRollInvocation;
  readonly uid: number;
}): MacOsLaunchAgentPlan {
  const programArguments = [input.invocation.command, ...input.invocation.companionArgs]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${COMPANION_SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(input.paths.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(input.paths.logPath)}</string>
  </dict>
</plist>
`;
  const domainTarget = `gui/${String(input.uid)}`;
  return {
    label: COMPANION_SERVICE_LABEL,
    plistPath: input.paths.launchAgentPath,
    plist,
    domainTarget,
    serviceTarget: `${domainTarget}/${COMPANION_SERVICE_LABEL}`,
  };
}

export interface WindowsScheduledTaskPlan {
  readonly taskName: string;
  readonly taskCommand: string;
  readonly create: ProcessInvocation;
  readonly remove: ProcessInvocation;
  readonly start: ProcessInvocation;
  readonly stop: ProcessInvocation;
  readonly query: ProcessInvocation;
}

export function createWindowsScheduledTaskPlan(
  invocation: BundledRollInvocation,
  windowsDirectory?: string,
): WindowsScheduledTaskPlan {
  const taskCommand = [invocation.command, ...invocation.companionArgs]
    .map(quoteWindowsCommandArgument)
    .join(" ");
  const taskSchedulerExecutable = resolveWindowsScheduledTasksExecutable(windowsDirectory);
  const powershellExecutable = resolveWindowsPowerShellExecutable(windowsDirectory);
  const queryScript = `$taskName = ${createPowerShellUtf8StringExpression(WINDOWS_COMPANION_TASK_NAME)}\n${WINDOWS_TASK_STATE_QUERY_SCRIPT}`;
  return {
    taskName: WINDOWS_COMPANION_TASK_NAME,
    taskCommand,
    create: {
      command: taskSchedulerExecutable,
      args: [
        "/Create",
        "/F",
        "/SC",
        "ONLOGON",
        "/RL",
        "LIMITED",
        "/TN",
        WINDOWS_COMPANION_TASK_NAME,
        "/TR",
        taskCommand,
      ],
    },
    remove: {
      command: taskSchedulerExecutable,
      args: ["/Delete", "/F", "/TN", WINDOWS_COMPANION_TASK_NAME],
    },
    start: {
      command: taskSchedulerExecutable,
      args: ["/Run", "/TN", WINDOWS_COMPANION_TASK_NAME],
    },
    stop: {
      command: taskSchedulerExecutable,
      args: ["/End", "/TN", WINDOWS_COMPANION_TASK_NAME],
    },
    query: {
      command: powershellExecutable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", queryScript],
    },
  };
}

export class MacOsLaunchAgentController implements CompanionServiceController {
  private readonly plan: MacOsLaunchAgentPlan;
  private readonly runner: ProcessRunner;

  constructor(plan: MacOsLaunchAgentPlan, runner: ProcessRunner = new SpawnProcessRunner()) {
    this.plan = plan;
    this.runner = runner;
  }

  async install(): Promise<void> {
    await atomicWritePrivate(this.plan.plistPath, this.plan.plist);
    const current = await this.inspectLaunchd();
    if (!current.loaded) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["bootstrap", this.plan.domainTarget, this.plan.plistPath],
      });
    } else if (!current.running) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["kickstart", this.plan.serviceTarget],
      });
    }
  }

  async uninstall(): Promise<void> {
    await this.stop();
    await unlink(this.plan.plistPath).catch((error: unknown) => {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    });
  }

  async start(): Promise<void> {
    const status = await this.inspectLaunchd();
    if (!status.installed) {
      throw new Error("Roll Companion service is not installed");
    }
    if (!status.loaded) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["bootstrap", this.plan.domainTarget, this.plan.plistPath],
      });
    } else if (!status.running) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["kickstart", this.plan.serviceTarget],
      });
    }
  }

  async stop(): Promise<void> {
    const status = await this.inspectLaunchd();
    if (status.loaded) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["bootout", this.plan.serviceTarget],
      });
    }
  }

  async status(): Promise<CompanionServiceStatus> {
    const status = await this.inspectLaunchd();
    return { installed: status.installed, running: status.running };
  }

  private async inspectLaunchd(): Promise<{
    readonly installed: boolean;
    readonly loaded: boolean;
    readonly running: boolean;
  }> {
    const installed = await fileExists(this.plan.plistPath);
    const result = await this.runner.run({
      command: "/bin/launchctl",
      args: ["print", this.plan.serviceTarget],
    });
    return {
      installed,
      loaded: result.code === 0,
      running: result.code === 0 && /\bstate\s*=\s*running\b/i.test(result.stdout),
    };
  }

  private async runRequired(invocation: ProcessInvocation): Promise<void> {
    const result = await this.runner.run(invocation);
    if (result.code !== 0) {
      throw new Error("Unable to update the per-user macOS Companion service");
    }
  }
}

export class WindowsScheduledTaskController implements CompanionServiceController {
  private readonly plan: WindowsScheduledTaskPlan;
  private readonly runner: ProcessRunner;

  constructor(plan: WindowsScheduledTaskPlan, runner: ProcessRunner = new SpawnProcessRunner()) {
    this.plan = plan;
    this.runner = runner;
  }

  async install(): Promise<void> {
    await this.runRequired(this.plan.create, "Unable to install the current-user Companion task");
    await this.start();
  }

  async uninstall(): Promise<void> {
    await this.stop();
    const status = await this.status();
    if (status.installed) {
      await this.runRequired(
        this.plan.remove,
        "Unable to uninstall the current-user Companion task",
      );
    }
  }

  async start(): Promise<void> {
    const status = await this.status();
    if (!status.installed) {
      throw new Error("Roll Companion service is not installed");
    }
    await this.runRequired(this.plan.start, "Unable to start the current-user Companion task");
  }

  async stop(): Promise<void> {
    const status = await this.inspectTaskState();
    if (status.state === undefined) {
      return;
    }
    await this.runner.run(this.plan.stop);
    const finalStatus = await this.inspectTaskState();
    if (
      finalStatus.state !== undefined &&
      finalStatus.state !== WINDOWS_TASK_STATES.disabled &&
      finalStatus.state !== WINDOWS_TASK_STATES.ready
    ) {
      throw new Error("Unable to stop the current-user Companion task");
    }
    // `/End` may race with a task that has just stopped, so only the invariant state query above is
    // authoritative. Its result confirms that the task is no longer running.
  }

  async status(): Promise<CompanionServiceStatus> {
    const status = await this.inspectTaskState();
    if (status.state === undefined) {
      return { installed: false, running: false };
    }
    if (
      status.state === WINDOWS_TASK_STATES.unknown ||
      status.state === WINDOWS_TASK_STATES.queued
    ) {
      throw new Error("The current-user Companion task state is indeterminate");
    }
    return {
      installed: true,
      running: status.state === WINDOWS_TASK_STATES.running,
    };
  }

  private async inspectTaskState(): Promise<{ readonly state: WindowsTaskState | undefined }> {
    const result = await this.runner.run(this.plan.query);
    if (result.code !== 0) {
      throw new Error("Unable to inspect the current-user Companion task");
    }
    const output = result.stdout.trim();
    if (output === "missing") {
      return { state: undefined };
    }
    const stateMatch = /^state:([0-4])$/u.exec(output);
    const state = Number(stateMatch?.[1]);
    if (!isWindowsTaskState(state)) {
      throw new Error("The current-user Companion task returned an invalid state");
    }
    return { state };
  }

  private async runRequired(invocation: ProcessInvocation, message: string): Promise<void> {
    const result = await this.runner.run(invocation);
    if (result.code !== 0) {
      throw new Error(message);
    }
  }
}

function isWindowsTaskState(value: number): value is WindowsTaskState {
  return WINDOWS_TASK_STATE_VALUES.has(value);
}

export function createPlatformServiceController(options: {
  readonly paths: CompanionPaths;
  readonly invocation: BundledRollInvocation;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly runner?: ProcessRunner;
  readonly windowsDirectory?: string;
}): CompanionServiceController {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? new SpawnProcessRunner();
  if (platform === "darwin") {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) {
      throw new Error("Unable to identify the current macOS user for LaunchAgent installation");
    }
    return new MacOsLaunchAgentController(
      createMacOsLaunchAgentPlan({ paths: options.paths, invocation: options.invocation, uid }),
      runner,
    );
  }
  if (platform === "win32") {
    return new WindowsScheduledTaskController(
      createWindowsScheduledTaskPlan(options.invocation, options.windowsDirectory),
      runner,
    );
  }
  throw new Error("roll companion service supports macOS and Windows only");
}

async function atomicWritePrivate(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replaceAll(/(\\+)$/g, "$1$1")}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
